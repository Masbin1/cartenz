import { Logger } from '@nestjs/common';
import type { AppConfig } from '../../core/config/configuration';
import { generatedFileTemplate, insertGeneratedBlock } from '../orchestration/generated-block';
import type {
  ModelProvider,
  ModelResult,
  PromptPart,
  StructuredRequest,
  ToolLoopOutcome,
  ToolLoopRequest,
} from './model-provider.interface';

/**
 * A deterministic provider that makes no network call (ADR-020).
 *
 * This is a first-class implementation rather than a stub, and the distinction is
 * the point: it runs the same loop, calls the same tools through the same
 * executor, honours the same budgets and returns the same shapes. So the
 * orchestration, the AI data boundary, the permission validator, the approval gate
 * and the persistence are all genuinely exercised on a deployment with no provider
 * configured - which is every deployment until a key is issued.
 *
 * What it cannot exercise is the model's judgement. It selects tools by a fixed
 * script rather than by reasoning, and it says so: `callsExternalService` is false,
 * and every plan and summary it produces states its origin.
 */
export class ScriptedModelProvider implements ModelProvider {
  private readonly logger = new Logger(ScriptedModelProvider.name);

  readonly id = 'mock';
  readonly model: string;
  readonly callsExternalService = false;

  constructor(config: AppConfig) {
    this.model = config.ai.model;
  }

  /**
   * Produces the plan.
   *
   * Specialised to the plan schema rather than being a general schema-satisfier: a
   * general one would be considerably more code and would still only ever be asked
   * for a plan.
   */
  async generateStructured<T>(request: StructuredRequest<T>): Promise<ModelResult<T>> {
    const startedAt = Date.now();
    const context = readContext(request.parts);

    // Validated against the caller's schema exactly as a real provider's output
    // would be, so a change to the schema fails here rather than downstream.
    const parsed = request.schema.safeParse(buildScriptedPlan(context));
    if (!parsed.success) {
      throw new Error(
        `The scripted provider produced a value that does not satisfy ${request.schemaName}: ` +
          parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
      );
    }

    return {
      value: parsed.data,
      usage: {
        inputTokens: estimateTokens(request.parts),
        outputTokens: 0,
        durationMs: Date.now() - startedAt,
      },
      boundaryFindings: [],
      redactionCount: 0,
      steps: 1,
    };
  }

  /**
   * Carries out the approved plan through a fixed sequence of tool calls.
   *
   * Shaped like what a model would do - orient, read each file, write it back,
   * then check the result - so that the loop, the budgets, the halting behaviour
   * and the read-then-write pattern are exercised rather than merely present.
   */
  async runToolLoop(request: ToolLoopRequest): Promise<ModelResult<ToolLoopOutcome>> {
    const startedAt = Date.now();
    const context = readContext(request.parts);
    const available = new Set(request.tools.map((tool) => tool.name));

    let toolCalls = 0;
    let steps = 0;
    let haltReason: string | undefined;
    const written: string[] = [];
    const skipped: string[] = [];

    /**
     * Runs one call against the budgets.
     *
     * Returns null once a budget is exhausted or the platform halts, so the caller
     * stops rather than continuing to spend a budget it has already used.
     */
    const call = async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<Record<string, unknown> | null> => {
      if (haltReason) return null;

      steps += 1;
      if (steps > request.maxSteps) {
        haltReason = `the step budget of ${request.maxSteps} was exhausted`;
        return null;
      }
      if (toolCalls >= request.maxToolCalls) {
        haltReason = `the tool-call budget of ${request.maxToolCalls} was exhausted`;
        return null;
      }
      if (!available.has(name)) return null;

      toolCalls += 1;
      const outcome = await request.execute(name, args);

      if (outcome.halt) {
        haltReason = outcome.haltReason ?? 'the platform halted the loop';
        return null;
      }
      return outcome.result;
    };

    // Orient first, as a model would.
    await call('git_status', {});

    /**
     * Read, then write - the same pattern the instruction demands of a model, and
     * for the same reason: the write tools replace a file entirely, so writing
     * without reading destroys it.
     */
    for (const planned of context.plannedFiles.slice(0, 4)) {
      if (haltReason) break;

      const read = await call('read_file', { path: planned.path });
      const existing = typeof read?.content === 'string' ? read.content : null;
      const summary = context.planSummary || `Change to ${planned.path}`;

      // A partial read must never be written back. update_file replaces the whole
      // file, so appending to a truncated read deletes everything past the cut -
      // which is what happened on the first run against a real repository
      // (ADR-022). The file is skipped and the reason reported, rather than
      // producing a change that looks plausible in a diff.
      if (existing !== null && read?.truncated === true) {
        skipped.push(planned.path);
        this.logger.warn(
          `Skipped ${planned.path}: read_file truncated it, and writing back a ` +
            'partial read would delete the remainder.',
        );
        continue;
      }

      const content =
        existing === null
          ? generatedFileTemplate(planned.path, summary)
          : insertGeneratedBlock(existing, planned.path, summary);

      const wrote = await call(existing === null ? 'create_file' : 'update_file', {
        path: planned.path,
        content,
        summary: planned.reason || summary,
      });

      if (wrote) written.push(planned.path);
    }

    // Check its own work before finishing, as the instruction asks.
    await call('git_diff', {});

    this.logger.log(
      `Scripted loop: ${toolCalls} tool call(s), ${written.length} file(s) written` +
        (skipped.length > 0 ? `, ${skipped.length} skipped as truncated` : '') +
        (haltReason ? `, halted because ${haltReason}` : ''),
    );

    return {
      value: {
        summary: buildScriptedSummary(context, written, haltReason),
        toolCalls,
        haltReason,
      },
      usage: {
        inputTokens: estimateTokens(request.parts),
        outputTokens: 0,
        durationMs: Date.now() - startedAt,
      },
      steps,
      boundaryFindings: [],
      redactionCount: 0,
    };
  }
}

/**
 * What the scripted provider reads out of a prompt.
 *
 * A real model reads the prompt text; this reads the labelled parts the agent
 * supplied, which carry the same facts in a form a function can use.
 */
interface ScriptedContext {
  readonly request: string;
  readonly projectName: string;
  readonly odooVersion: string | null;
  readonly targetModel: string;
  readonly targetPaths: readonly string[];
  readonly moduleNames: readonly string[];
  /** From the approved plan, present during the implementation loop. */
  readonly planSummary: string;
  readonly plannedFiles: readonly { readonly path: string; readonly reason: string }[];
}

function readContext(parts: readonly PromptPart[]): ScriptedContext {
  const find = (label: string) =>
    parts.find((part) => part.label.toLowerCase() === label.toLowerCase())?.content ?? '';

  const facts = safeJson(find('Repository analysis'));
  const plan = safeJson(find('Approved implementation plan'));

  const plannedFiles = Array.isArray(plan.filesToModify)
    ? (plan.filesToModify as unknown[])
        .filter(
          (entry): entry is Record<string, unknown> =>
            typeof entry === 'object' && entry !== null,
        )
        .map((entry) => ({ path: String(entry.path ?? ''), reason: String(entry.reason ?? '') }))
        .filter((entry) => entry.path.length > 0)
    : [];

  return {
    request: find('Development request').trim(),
    projectName: String(facts.projectName ?? 'the project'),
    odooVersion: typeof facts.odooVersion === 'string' ? facts.odooVersion : null,
    targetModel: String(facts.targetModel ?? 'res.config.settings'),
    targetPaths: Array.isArray(facts.candidatePaths)
      ? (facts.candidatePaths as unknown[]).filter(
          (path): path is string => typeof path === 'string',
        )
      : [],
    moduleNames: Array.isArray(facts.modules)
      ? (facts.modules as unknown[]).filter((name): name is string => typeof name === 'string')
      : [],
    planSummary: typeof plan.summary === 'string' ? plan.summary : '',
    plannedFiles,
  };
}

function safeJson(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * The plan.
 *
 * Grounded in the analysis it was given - real module names, real candidate paths
 * - so that what it produces is applicable, and honest about its origin so that
 * nobody mistakes it for reasoning.
 */
function buildScriptedPlan(context: ScriptedContext) {
  const fallbackModule = context.moduleNames[0] ?? 'custom_module';
  const slug = context.targetModel.replace(/[.]/g, '_');

  const modelPath =
    context.targetPaths.find((path) => path.endsWith('.py')) ??
    `${fallbackModule}/models/${slug}.py`;
  const viewPath =
    context.targetPaths.find((path) => path.endsWith('.xml')) ??
    `${fallbackModule}/views/${slug}_views.xml`;

  const found = context.targetPaths.length > 0;

  return {
    summary:
      `Implement the requested change to ${context.targetModel} in ${context.projectName}. ` +
      (found
        ? `${context.targetPaths.length} related file(s) were located in the repository.`
        : 'No existing definition was located, so new files will be created.'),
    odooVersion: context.odooVersion,
    steps: [
      {
        order: 1,
        title: `Extend the ${context.targetModel} model`,
        detail: found
          ? `Add the field to ${modelPath}, following the conventions already used in that file.`
          : `Create ${modelPath} with the field definition.`,
      },
      {
        order: 2,
        title: 'Expose the field in the interface',
        detail: `Add the field to ${viewPath} so that it appears on the form and list views.`,
      },
      {
        order: 3,
        title: 'Confirm access rules',
        detail:
          'A field added to an existing model inherits that model’s access rules, so no new rule is expected. This step confirms it.',
      },
      {
        order: 4,
        title: 'Validate the change',
        detail:
          'Run static analysis, the Python tests and the Odoo module tests against an isolated temporary database.',
      },
    ],
    filesToModify: [
      {
        path: modelPath,
        change: found ? ('modified' as const) : ('added' as const),
        reason: `Add the field to the ${context.targetModel} model`,
      },
      {
        path: viewPath,
        change: found ? ('modified' as const) : ('added' as const),
        reason: 'Expose the field on the form and list views',
      },
    ],
    validation: ['run_linter', 'run_python_test', 'run_odoo_test'],
    risks: [
      'A field added to a shared model affects every view that inherits it.',
      'A module upgrade is required before the field is available in an existing database.',
      'This plan was produced by the scripted provider without reasoning about the code. Review the paths and the intent before approving.',
      ...(found
        ? []
        : [
            'No existing model definition was located, so the change creates new files rather than extending existing ones.',
          ]),
    ],
  };
}

function buildScriptedSummary(
  context: ScriptedContext,
  written: readonly string[],
  haltReason: string | undefined,
): string {
  if (haltReason) {
    return `Stopped after writing ${written.length} file(s): ${haltReason}.`;
  }

  if (written.length === 0) {
    return 'No file was changed: the plan named no file that could be written.';
  }

  return (
    `Applied the approved plan to ${context.targetModel}, changing ${written.join(', ')}. ` +
    'Written by the scripted provider: this deployment has no AI provider configured, so no model reasoned about the code.'
  );
}

/**
 * A rough token count, for the usage record.
 *
 * Four characters per token is the usual approximation for English and code. It is
 * an estimate and is labelled as one wherever it is shown; the point is that a
 * deployment without a provider still records comparable figures rather than zeroes.
 */
function estimateTokens(parts: readonly PromptPart[]): number {
  const characters = parts.reduce((total, part) => total + part.content.length, 0);
  return Math.ceil(characters / 4);
}
