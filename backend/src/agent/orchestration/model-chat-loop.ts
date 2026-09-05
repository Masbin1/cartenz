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

/** A tool call, in the shape the loop hands back to its caller. */
export interface ChatLoopToolCall {
  readonly name: string;
  readonly input: Record<string, unknown>;
}

/**
 * Executes one tool call. Supplied by the workflow rather than implemented here,
 * exactly as the implementation loop's runner is (ADR-020): this class decides
 * nothing about whether a call may run. The platform's own execution path
 * applies the permission validator, the project's agent permissions and the
 * approval gate - so a chat write reaches `chat_edit` before anything changes.
 */
export type ChatLoopToolRunner = (
  call: ChatLoopToolCall,
) => Promise<{ status: LoopToolResult; output: Record<string, unknown> }>;

/** Mirrors the implementation loop's tool status vocabulary. */
export type LoopToolResult = 'succeeded' | 'failed' | 'denied' | 'approval_required';

export interface ChatLoopInput {
  readonly organizationId: string;
  /** Scopes an agent-backed endpoint's memory to this project, when known. */
  readonly projectId?: string;
  readonly prompt: string;
  readonly projectName: string;
  readonly taskReference: string;
  readonly branch: string;
  readonly odooVersion: string | null;
  readonly agentPermissions: Record<string, boolean>;
  /**
   * The execution mode this task runs in (ADR-028). Read tools are mode-gated,
   * so a chat on `odoo_online` is offered the Odoo read tools rather than a
   * filesystem it does not have.
   */
  readonly executionMode?: ExecutionMode | null;
  /**
   * Earlier turns of the conversation this task belongs to, if the caller has
   * them. Rendered after the current prompt so the model answers in context.
   */
  readonly conversationContext?: readonly PromptPart[];
  readonly run: ChatLoopToolRunner;
}

export interface ChatLoopOutcome {
  /** The model's natural-language answer. */
  readonly answer: string;
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
 * The conversational loop (ADR-029).
 *
 * The same machinery as ModelImplementationLoop, run without an approved plan:
 * the model reads the repository through tools and answers a question in plain
 * language. A write tool is offered but is gated behind the `chat_edit`
 * approval by the permission validator, so a chat task that writes suspends into
 * `waiting_approval` exactly as a change task does.
 */
@Injectable()
export class ChatLoop {
  private readonly logger = new Logger(ChatLoop.name);

  constructor(
    private readonly providers: ModelProviderResolver,
    private readonly registry: ToolRegistry,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async run(input: ChatLoopInput): Promise<ChatLoopOutcome> {
    const provider = await this.providers.forOrganization(input.organizationId, input.projectId);
    const tools = this.offeredTools(input.agentPermissions, input.executionMode ?? null);

    // An empty tool list is legitimate for a chat task: an `ai_project` has no
    // execution mode, so no mode-gated tool is offered, and the model answers
    // from the conversation itself (the project specification). Unlike the
    // implementation loop, there is no repository the model must reach, so an
    // empty list is not a configuration error - it is the read-only answer path.
    if (tools.length === 0) {
      this.logger.log(
        `Chat loop for ${input.taskReference}: no tools offered ` +
          `(execution mode: ${input.executionMode ?? 'not set'}); answering without tool access.`,
      );
    }

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
        // re-enters the workflow. The model must not reason about a suspension
        // it cannot resolve.
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
      system: `${system}\n\n${CHAT_INSTRUCTION}`,
      parts: this.buildParts(input),
      tools,
      execute,
      maxSteps: this.config.ai.maxSteps,
      maxToolCalls: this.config.ai.maxToolCalls,
    });

    this.logger.log(
      `Chat loop for ${input.taskReference}: ${result.value.toolCalls} tool call(s), ` +
        `${result.steps} step(s)${result.value.haltReason ? `, halted because ${result.value.haltReason}` : ''}`,
    );

    return {
      answer: result.value.summary,
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
   * The same filter the implementation loop applies: `availableToModel` excludes
   * the tools the workflow drives itself (committing, pushing, validation), and
   * the permission check excludes what the project has not granted. A chat task
   * is offered read and write tools alike, so the model may read freely and, if
   * it is asked to change something, reach the `chat_edit` approval.
   */
  private offeredTools(
    agentPermissions: Record<string, boolean>,
    executionMode: ExecutionMode | null,
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
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));
  }

  private buildParts(input: ChatLoopInput): PromptPart[] {
    const parts: PromptPart[] = [
      { label: 'Conversation', content: input.prompt, untrusted: false },
    ];

    for (const part of input.conversationContext ?? []) {
      parts.push(part);
    }

    return parts;
  }
}

/**
 * The chat instruction.
 *
 * What earns its place here is the split between reading and writing: a chat
 * task may read anything, but a write pauses the task for a person. The model is
 * told the truth about that so it answers rather than edits when the question
 * does not ask for a change, and says what it would change when it does.
 */
const CHAT_INSTRUCTION = [
  '# This conversation',
  'You are answering a question about this project. Read freely - the repository',
  'is there to be understood. Answer in plain language, naming real files and',
  'symbols you have actually read.',
  '',
  'How to work:',
  '- Read whatever you need with read_file, search_code, list_directory and',
  '  list_modules. Reading never requires approval.',
  '- If the answer needs a file changed, prefer to describe what you WOULD change',
  '  and why, rather than changing it. Any write requires a person\'s approval,',
  '  which pauses the task.',
  '- You may use a write tool (edit_file, update_file, create_file) if a change is',
  '  clearly wanted; the platform will pause for approval before anything is',
  '  written. When in doubt, explain instead of writing.',
  '- Do not commit or push. A chat never does.',
  '',
  'Finish with a plain-language answer to the question. If you would change',
  'something, say what and where.',
].join('\n');
