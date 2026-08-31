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
) => Promise<{ status: LoopToolResult; output: Record<string, unknown> }>;

export interface ImplementationLoopInput {
  /**
   * Whose model provider to use (ADR-023). The configuration is per
   * organisation, so the caller must say which one rather than the loop assuming
   * a single provider bound at boot.
   */
  readonly organizationId: string;
  readonly prompt: string;
  readonly projectName: string;
  readonly taskReference: string;
  readonly branch: string;
  readonly odooVersion: string | null;
  readonly plan: ImplementationPlan;
  /** Deciding whether a tool may be offered at all. */
  readonly agentPermissions: Record<string, boolean>;
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
    const provider = await this.providers.forOrganization(input.organizationId);
    const tools = this.offeredTools(input.agentPermissions);

    const system = buildSystemPrompt({
      projectName: input.projectName,
      odooVersion: input.odooVersion,
      branch: input.branch,
      grantedTools: tools.map((tool) => tool.name),
    });

    let suspended = false;

    const execute = async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<ToolCallOutcome> => {
      const outcome = await input.run({ name, input: args });

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
        // different approach within what it is permitted to do.
        return {
          result: {
            status: 'denied',
            message: 'The platform refused this call. Do not retry it or work around it.',
            detail: outcome.output,
          },
        };
      }

      return { result: { status: outcome.status, ...outcome.output } };
    };

    const result = await provider.runToolLoop({
      system: `${system}\n\n${IMPLEMENTATION_INSTRUCTION}`,
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
   */
  private offeredTools(agentPermissions: Record<string, boolean>): ModelTool[] {
    return this.registry
      .all()
      .filter((tool) => tool.availableToModel)
      .filter((tool) => agentPermissions[tool.permission] === true)
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
  '- Do not commit or push. Those happen after validation, and are not yours to do.',
  '- Stop when the plan is carried out. Do not look for further improvements.',
  '',
  'Finish with a short summary of what you changed and anything the reviewer should',
  'look at. Do not claim to have changed a file unless a tool result shows that you did.',
].join('\n');
