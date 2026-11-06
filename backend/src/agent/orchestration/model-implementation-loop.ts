import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG } from '../../core/config/config.module';
import type { AppConfig } from '../../core/config/configuration';
import {
  type ModelTool,
  type PromptPart,
  type ToolCallOutcome,
} from '../model/model-provider.interface';
import { buildSystemPrompt } from '../model/prompt-assembly';
import { ModelProviderResolver } from '../model/model-provider-resolver';
import { ToolRegistry } from '../tools/tool-registry';
import type { ExecutionMode } from '../executors/execution-mode';
import type { BoundaryFinding } from '../../core/ai-boundary/boundary-types';
import type { ImplementationPlan } from './agent-plan';

/**
 * How the loop reports what a tool did, back to the caller.
 *
 * `denied` and `approval_required` are distinguished because they mean different
 * things: a denial is final and the model should stop trying, while an approval
 * requirement suspends the task and is resolved by a person.
 */
export type LoopToolResult = 'succeeded' | 'failed' | 'denied' | 'approval_required';

export interface LoopToolCall {
  readonly name: string;
  readonly input: Record<string, unknown>;
}

/**
 * Executes one tool call.
 *
 * Supplied by the workflow rather than implemented here, and that is the design:
 * this class decides nothing about whether a call may run. It hands the request to
 * the platform's own execution path, which applies the permission validator, the
 * project's agent permissions and the approval gate exactly as it does for a call
 * the workflow made itself (ADR-020).
 */
export type LoopToolRunner = (
  call: LoopToolCall,
) => Promise<{
  status: LoopToolResult;
  output: Record<string, unknown>;
  /**
   * Why a refused call was refused, in the validator's own words.
   *
   * Carried back to the model rather than kept for the audit trail alone. A
   * denial has two quite different causes - a policy that forbids the tool, and
   * a request the model can simply correct - and a generic refusal makes them
   * indistinguishable. A model told only "refused" retries the same malformed
   * call with a cosmetic variation, exhausts its attempts and reports the
   * platform as blocking it.
   */
  denialReason?: string;
}>;

export interface ImplementationLoopInput {
  /**
   * Scopes an agent-backed endpoint's memory to this project, when known
   * (ADR-023). The provider chain itself is global (ADR-044), so this is the
   * only thing the caller passes.
   */
  readonly projectId?: string;
  /** This project may only use on-host models (ADR-055). */
  readonly localProviderOnly?: boolean;
  readonly prompt: string;
  readonly projectName: string;
  /** The project brief from its specification; the agent's standing context. */
  readonly projectBrief?: string | null;
  readonly taskReference: string;
  readonly branch: string;
  readonly odooVersion: string | null;
  readonly plan: ImplementationPlan;
  /** Deciding whether a tool may be offered at all. */
  readonly agentPermissions: Record<string, boolean>;
  /**
   * The execution mode this task runs in (ADR-028). Offering a tool that is
   * illegal in the mode is not a security problem - the validator refuses it
   * either way - but a model spending its budget being told no produces a worse
   * result, and on `odoo_online` it would be offered a whole filesystem it does
   * not have.
   */
  readonly executionMode?: ExecutionMode | null;
  /** Read-only Odoo source prefixes available to this task (ADR-031). */
  readonly odooSourcePrefixes?: readonly string[];
  /**
   * This task's own successful tool calls so far (ADR-092), when this is a
   * resumption after an approval suspended it mid-implementation. Empty on a
   * task's first pass.
   */
  readonly priorProgress?: readonly PromptPart[];
  /**
   * 'verify' (ADR-094, odoo_online only) runs this loop a second time after a
   * successful implementation, to check the result rather than make more of
   * it: the schema-write tools (odoo_create_field, odoo_create_model,
   * odoo_add_field_to_view) are withheld so a verification pass cannot
   * silently become a second implementation pass, and the instruction asks
   * for a real check (sample data created or read back, a computed value
   * compared to hand arithmetic) rather than a repeat of the plan. Defaults
   * to 'implement', the existing behaviour.
   */
  readonly mode?: 'implement' | 'verify';
  readonly run: LoopToolRunner;
}

export interface ImplementationLoopOutcome {
  readonly summary: string;
  readonly toolCalls: number;
  readonly steps: number;
  /** Set when the loop stopped for a reason other than the model finishing. */
  readonly haltReason?: string;
  /** True when a tool needed an approval, so the task must suspend. */
  readonly suspended: boolean;
  readonly usage: { inputTokens: number; outputTokens: number; durationMs: number };
  readonly boundaryFindings: readonly BoundaryFinding[];
  readonly redactionCount: number;
  readonly providerId: string;
  readonly model: string;
  readonly calledExternalService: boolean;
  /**
   * The last successful `git_pull` this loop made, if any.
   *
   * Read by the workflow's no-change gate: a plan that was purely "pull the
   * latest changes" leaves nothing in the diff for that gate to see, and
   * without this the gate could not tell that apart from a model that did
   * nothing. `git_pull`'s own output carries these fields (see the tool), so
   * this only has to remember the last one, not reshape it.
   */
  readonly pulled?: {
    readonly outcome: 'up_to_date' | 'fast_forwarded';
    readonly branch: string;
    readonly commits: number;
  } | null;
}

/**
 * The implementation loop (chapter 6, ADR-020).
 *
 * The model reads the repository through tools, writes its changes through tools,
 * and stops. Every call it makes goes through the same mediated path the workflow
 * uses; the model's authority is exactly the set of tools offered to it, and its
 * reach within them is exactly what the project grants.
 *
 * Three bounds apply, and any of them ending the loop is reported rather than
 * hidden: a step budget, a tool-call budget, and the provider's own request
 * timeout. A loop that exhausts one has not failed silently.
 */
@Injectable()
export class ModelImplementationLoop {
  private readonly logger = new Logger(ModelImplementationLoop.name);

  constructor(
    private readonly providers: ModelProviderResolver,
    private readonly registry: ToolRegistry,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async run(input: ImplementationLoopInput): Promise<ImplementationLoopOutcome> {
    const provider = await this.providers.forProject(input.projectId, { localOnly: input.localProviderOnly });
    const tools = this.offeredTools(input.agentPermissions, input.executionMode ?? null, input.mode);

    // An empty tool list means the model is asked to change a repository with no
    // way to touch it. It answers that it cannot, changes nothing, and the run
    // fails one model call later as "made no change to the working tree" - which
    // points at the model rather than at the configuration that caused it. The
    // cause is always here: a permission set that grants nothing, or a caller
    // that omitted executionMode so every mode-gated tool was filtered out.
    if (tools.length === 0) {
      throw new Error(
        'No tools are available to the model for this task ' +
          `(execution mode: ${input.executionMode ?? 'not set'}). ` +
          'Check the project\'s agent permissions.',
      );
    }

    const system = buildSystemPrompt({
      projectName: input.projectName,
      projectBrief: input.projectBrief,
      odooVersion: input.odooVersion,
      branch: input.branch,
      grantedTools: tools.map((tool) => tool.name),
      odooSourcePrefixes: input.odooSourcePrefixes,
    });

    let suspended = false;
    let pulled: ImplementationLoopOutcome['pulled'] = null;

    const execute = async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<ToolCallOutcome> => {
      const outcome = await input.run({ name, input: args });

      if (name === 'git_pull' && outcome.status === 'succeeded') {
        const reported = outcome.output.outcome;
        if (reported === 'up_to_date' || reported === 'fast_forwarded') {
          pulled = {
            outcome: reported,
            branch: String(outcome.output.branch ?? input.branch),
            commits: Number(outcome.output.commits ?? 0) || 0,
          };
        }
      }

      if (outcome.status === 'approval_required') {
        // Halts the loop. The task suspends, a person decides, and a fresh run
        // re-enters the workflow. Letting the model continue would have it
        // reasoning about a suspension it cannot resolve.
        suspended = true;
        return {
          result: {
            status: 'approval_required',
            message:
              'This action requires a human approval. The task is now paused and you should stop.',
          },
          halt: true,
          haltReason: `${name} requires a human approval`,
        };
      }

      if (outcome.status === 'denied') {
        // Not a halt: a denial is information the model can act on by choosing a
        // different approach within what it is permitted to do. The reason is
        // included because acting on it requires knowing what was wrong - a
        // missing required argument and a forbidden capability are both denials,
        // and only one of them is worth another attempt.
        //
        // A malformed-request denial (permission-validator's `invalid request for
        // ...` prefix) is always the caller's mistake, never policy: the fix is in
        // the model's own next call, not a different approach. Telling it "try a
        // different approach" here is how a fixable typo turned into "the platform
        // is blocking me" - the model correctly read that it should not repeat the
        // SAME broken call, and wrongly concluded that meant giving up rather than
        // calling the tool again with the one field corrected.
        const correctable = outcome.denialReason?.startsWith('invalid request for') ?? false;

        return {
          result: {
            status: 'denied',
            message: outcome.denialReason
              ? correctable
                ? `${name} was refused: ${outcome.denialReason}. This is a request you can fix, ` +
                  `not a forbidden action - call ${name} again right now with that argument ` +
                  'corrected. Do not skip this file, do not report the platform as blocking you, ' +
                  'and do not finish until the corrected call has succeeded.'
                : `The platform refused this call: ${outcome.denialReason}`
              : 'The platform refused this call. Do not retry it or work around it.',
            detail: outcome.output,
          },
        };
      }

      return { result: { status: outcome.status, ...outcome.output } };
    };

    const result = await provider.runToolLoop({
      system: `${system}\n\n${
        input.mode === 'verify'
          ? ODOO_ONLINE_VERIFY_INSTRUCTION
          : input.executionMode === 'odoo_online'
            ? ODOO_ONLINE_INSTRUCTION
            : IMPLEMENTATION_INSTRUCTION
      }`,
      parts: this.buildParts(input),
      tools,
      execute,
      maxSteps: this.config.ai.maxSteps,
      maxToolCalls: this.config.ai.maxToolCalls,
    });

    this.logger.log(
      `Implementation loop for ${input.taskReference}: ${result.value.toolCalls} tool call(s), ` +
        `${result.steps} step(s)${result.value.haltReason ? `, halted because ${result.value.haltReason}` : ''}`,
    );

    return {
      summary: result.value.summary,
      toolCalls: result.value.toolCalls,
      steps: result.steps,
      haltReason: result.value.haltReason,
      suspended,
      pulled,
      usage: result.usage,
      boundaryFindings: result.boundaryFindings,
      redactionCount: result.redactionCount,
      providerId: provider.id,
      model: provider.model,
      calledExternalService: provider.callsExternalService,
    };
  }

  /**
   * The tools offered to the model.
   *
   * Filtered twice, and both filters matter. `availableToModel` excludes the tools
   * the workflow drives itself - committing, pushing, validation - so a model
   * cannot commit before its work has been reviewed. The permission check excludes
   * what this project has not granted, so a model on a read-only project is not
   * offered a write tool it would only be refused.
   *
   * Offering a tool that would be refused is not a security problem, because the
   * validator refuses it either way. It is a quality problem: a model that spends
   * its budget being told no produces a worse result.
   *
   * A third filter applies only in `'verify'` mode (ADR-094): the schema-write
   * tools are withheld so a verification pass cannot silently become a second
   * implementation pass. Not a security boundary either - nothing stops a later
   * `change` task from creating more schema - just a guardrail against a
   * verification run quietly expanding its own scope.
   */
  private offeredTools(
    agentPermissions: Record<string, boolean>,
    executionMode: ExecutionMode | null,
    mode?: 'implement' | 'verify',
  ): ModelTool[] {
    return this.registry
      .all()
      .filter((tool) => tool.availableToModel)
      .filter(
        (tool) =>
          tool.modes === undefined ||
          (executionMode !== null && tool.modes.includes(executionMode)),
      )
      .filter((tool) => agentPermissions[tool.permission] === true)
      .filter((tool) => mode !== 'verify' || !VERIFY_EXCLUDED_TOOLS.includes(tool.name))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));
  }

  private buildParts(input: ImplementationLoopInput): PromptPart[] {
    const plan = {
      summary: input.plan.summary,
      steps: input.plan.steps,
      filesToModify: input.plan.filesToModify,
      risks: input.plan.risks,
    };

    return [
      { label: 'Development request', content: input.prompt, untrusted: false },
      {
        label: 'Approved implementation plan',
        content: JSON.stringify(plan, null, 2),
        untrusted: false,
      },
      ...(input.priorProgress ?? []),
    ];
  }
}

/**
 * The implementation instruction.
 *
 * The constraint that earns its place here is "read before you write": the write
 * tools replace a file entirely rather than patching it, so a model that writes
 * without reading destroys the file. Saying so is cheaper than the alternative,
 * which is a plausible-looking commit that deletes someone's code.
 */
const IMPLEMENTATION_INSTRUCTION = [
  '# This request',
  'A person has approved the plan below. Carry it out using the tools available to you.',
  '',
  'Rules:',
  '- If you create a new Odoo module, its technical name MUST strictly follow the pattern',
  '  `<project_name>_<app_name>_modifier` (e.g. `linkederp_sales_modifier`, `al3_sales_modifier`).',
  '- Always reply in Indonesian or English only in any summary you produce, matching',
  '  whichever the user used. If the request is in neither, default to Indonesian.',
  '- Before you finish, for EVERY file in the plan you must call a write tool',
  '  (edit_file, update_file, or create_file) so the change actually lands in the',
  '  working tree. A plan whose files you only read is not carried out, whatever',
  '  your summary says. Apply every planned change FIRST, confirmed by its tool',
  '  result, before writing your summary — git decides completion, not prose.',
  '  (A plan with an empty file list has no file to write: it is a pull, an',
  '  inspection, or a request to push commits that already exist. The summary you',
  '  end with IS the deliverable there.)',
  '',
  'How to work:',
  '- To change a file that already exists, use edit_file. Pass the exact existing',
  "  text as `find` and its replacement as `replace`. It cannot delete anything",
  "  you have not quoted, which makes it the safe choice for every edit to real code.",
  '- update_file replaces the ENTIRE file and is a last resort. If you use it you',
  '  must supply the complete new contents including everything you want to keep,',
  '  and if the read of that file was marked truncated you must not use it at all:',
  '  you would delete everything past the truncation point.',
  '- Follow the plan. If the repository turns out to differ from what the plan assumed,',
  '  do the smaller correct thing and explain the difference in your summary rather',
  '  than improvising something larger.',
  '- Use git_status or git_diff to check your own work before you finish.',
  '- When the request asks to pull, update or sync the branch, call git_pull FIRST,',
  '  before reading or writing anything, so you work on the latest code. If git_pull',
  '  reports "up_to_date", nothing new existed on the remote: that is a successful',
  '  pull, not a failure. If it is refused (diverged history, uncommitted changes),',
  '  report the refusal as it was given; do not try to work around it.',
  '- When the plan lists no files to modify and the request was only to pull, the',
  '  pull IS the whole task: do not invent a file change to have something to show.',
  '- Do not commit or push. Those happen after validation, and are not yours to do.',
  '  After a pull there is nothing to commit, and the platform knows that.',
  '- Stop when the plan is carried out. Do not look for further improvements.',
  '- Work efficiently: read only the files you actually need before writing, and do not',
  '  re-read a file you already read. Prefer the smallest correct change over an elaborate',
  '  one. Every extra step costs real time the person is waiting for.',
  '',
  'Finish with a SHORT summary (3-5 sentences, plain language, no code snippets, no file',
  'paths unless essential) describing what changed and why, written for someone who is',
  'not a developer. Do not claim to have changed a file unless a tool result shows that you did.',
].join('\n');

/**
 * The Odoo Online implementation instruction (ADR-028).
 *
 * The repository instruction above is about files - read before you write, do not
 * commit - and none of it applies here: there is no file to destroy and no commit
 * to make. What replaces it is the fact that matters in this mode, which is that
 * the effects are immediate and on a live system. There is no branch to discard.
 */
const ODOO_ONLINE_INSTRUCTION = [
  '# This request',
  'A person has approved the plan below. Carry it out on the live Odoo Online',
  'instance using the tools available to you.',
  '',
  'How to work:',
  '- Always reply in Indonesian or English only in your summary, matching whichever',
  '  the request used. If the request is in neither, default to Indonesian.',
  '- There is no repository, no file and no commit here. Do not look for one.',
  '- Every change you make takes effect immediately on a running system. There is no',
  '  branch and no undo: create exactly what the plan describes and nothing else.',
  '- odoo_create_field takes the field name WITHOUT the "x_" prefix; Odoo adds it.',
  '  It supports scalar types (char, text, html, integer, float, monetary, boolean,',
  '  date, datetime), "selection" (pass "options", a list of {value, label}), and',
  '  relational types many2one/one2many/many2many (pass "relation", the target model;',
  '  one2many also needs "relationField", the many2one on the target pointing back).',
  '  odoo_create_model takes the model name WITH the "x_" prefix and a human label.',
  '  odoo_add_field_to_view takes the full name INCLUDING "x_", which the create',
  '  result gives you.',
  '- Read with odoo_list_fields before you create a custom field, so you do not',
  '  create one that already exists or place one after a field that does not.',
  '- odoo_create_records and odoo_update_records write business records (products,',
  '  customers, and the like), when the plan calls for data rather than schema.',
  '  Use odoo_search_records first when the plan updates existing records, to find',
  '  the ids.',
  '- If a step the plan describes needs a tool that is not in your tool list, do not',
  '  substitute browser_click/browser_type to fill the same form by hand instead - a',
  '  manual click-through of a multi-field form reliably exhausts the step budget',
  '  before it finishes and the task fails anyway, having spent the whole budget.',
  '  Stop, do not attempt that step, and say in your summary which tool was missing',
  '  and what you completed instead.',
  '- Stop when the plan is carried out. Do not look for further improvements.',
  '',
  'Finish with a short summary of what you changed. Do not claim to have created',
  'anything unless a tool result returned its id.',
].join('\n');

/**
 * Tools withheld in `'verify'` mode (ADR-094) because they create schema -
 * `odoo_create_field`, `odoo_create_model`, `odoo_add_field_to_view` - the
 * class of action a verification pass must not perform, however plausible a
 * reason the model might construct for doing so mid-check.
 */
export const VERIFY_EXCLUDED_TOOLS = ['odoo_create_field', 'odoo_create_model', 'odoo_add_field_to_view'];

/**
 * The Odoo Online verification instruction (ADR-094).
 *
 * task_837942 created three Monetary fields through odoo_create_field and
 * reported success - which was true of the RPC call, but the fields were
 * empty static columns: odoo_create_field has no compute/depends parameter
 * at all, so "computed, recalculated automatically" was never actually
 * built. Nothing afterwards checked that the field behaved as asked, because
 * validateOdooOnline's prior behaviour was to record zero tests and move on
 * - true to its word ("there is no test suite to run"), but it meant a
 * schema change's correctness was never actually checked against anything.
 * This instruction is what runs in that gap: a second pass, after a
 * successful implementation, whose only job is to find out whether what was
 * just built behaves the way the request asked - not to build more of it.
 */
const ODOO_ONLINE_VERIFY_INSTRUCTION = [
  '# Verify what was just built',
  'The plan below was just carried out successfully on the live Odoo Online instance.',
  'Your only job now is to check whether it actually works as the request asked - not to',
  'change, extend or fix anything. If you find a problem, report it; do not try to correct it.',
  '',
  'You do NOT have odoo_create_field, odoo_create_model or odoo_add_field_to_view in this',
  'pass. If verifying properly would require creating more schema, say so in your summary',
  'instead of trying - that is a real limit of this pass, not something to work around.',
  '',
  'How to verify, depending on what the plan actually built:',
  '- A computed/derived field (profit, margin, a total, a status set by a condition): create',
  '  one or two sample records with odoo_create_records using plain round numbers you choose',
  '  yourself (so the right answer is easy to check by hand), covering the normal case and, if',
  '  the request mentioned one, the edge case (a zero or empty value). Read the field back with',
  '  odoo_search_records and compare it to what you calculate by hand from the inputs you used.',
  '  State both numbers in your summary - do not just say "it matched" without showing them.',
  '- A field with no formula behind it (a plain data field, a selection, a relation): confirm',
  '  with odoo_list_fields that it exists with the right type, and if useful, create one sample',
  '  record that sets it and read it back, to confirm Odoo accepts and stores the value.',
  '- An Automation Rule or Server Action built through the browser: if a browser session is',
  '  open, create a record through the browser that should trigger it, then check whether the',
  '  expected effect happened (a field changed, a status updated). If no session is open, say',
  '  so and that this could not be checked this way.',
  '- If NOTHING about what was built can be verified with the tools and access available in',
  '  this pass (no database_record_write/read, no open browser session), say exactly that -',
  '  do not invent a result. This is a real outcome, not a failure to hide.',
  '',
  'When you create sample records purely to verify, say so plainly in your summary so they',
  'are not mistaken for data the person asked for - they are check fixtures, not deliverables.',
  '',
  'Finish with a short, concrete verdict: VERIFIED (state what you checked and the numbers),',
  'FAILED (state exactly what did not match and the numbers), or NOT VERIFIABLE (state why -',
  'which access or tool was missing).',
].join('\n');
