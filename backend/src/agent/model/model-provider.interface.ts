import type { z } from 'zod';
import type { BoundaryFinding } from '../../core/ai-boundary/boundary-types';

/**
 * The model abstraction (ADR-03, ADR-020).
 *
 * Two operations, chosen to match what the agent needs rather than what any SDK
 * offers: a structured generation for the plan, and a tool loop for the
 * implementation. Keeping the surface this small is what makes the provider
 * genuinely swappable - a Vercel AI SDK provider, a self-hosted endpoint and the
 * scripted provider all satisfy it without leaking their differences upward.
 */

/** A message part, labelled so the boundary can name what it refused. */
export interface PromptPart {
  readonly label: string;
  readonly content: string;
  /**
   * True for material taken from the repository. Fenced and labelled as data in
   * the assembled prompt (ADR-020): a hint to the model, not a control.
   */
  readonly untrusted?: boolean;
}

export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly durationMs: number;
}

export interface ModelResult<T> {
  readonly value: T;
  readonly usage: ModelUsage;
  /** What the boundary removed on the way out and on the way back. */
  readonly boundaryFindings: readonly BoundaryFinding[];
  readonly redactionCount: number;
  /** How many model round trips the operation took. */
  readonly steps: number;
}

export interface StructuredRequest<T> {
  readonly system: string;
  readonly parts: readonly PromptPart[];
  readonly schema: z.ZodType<T>;
  readonly schemaName: string;
  readonly maxTokens?: number;
}

/** A tool the model may call, as the provider needs to describe it. */
export interface ModelTool {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the tool's arguments. */
  readonly parameters: Record<string, unknown>;
}

/**
 * Executes one tool call and returns what the model should see.
 *
 * Supplied by the agent, not the provider: the provider decides *which* tool the
 * model asked for, and the platform decides whether it may run. This is the seam
 * that keeps a model's authority equal to the tool registry (ADR-020).
 */
export type ToolExecutor = (
  name: string,
  args: Record<string, unknown>,
) => Promise<ToolCallOutcome>;

export interface ToolCallOutcome {
  /** What the model is told. Passed through the boundary before it is sent. */
  readonly result: Record<string, unknown>;
  /**
   * Stops the loop. Set when a tool needed an approval, so the model is not
   * asked to reason about a suspension it cannot resolve.
   */
  readonly halt?: boolean;
  readonly haltReason?: string;
}

export interface ToolLoopRequest {
  readonly system: string;
  readonly parts: readonly PromptPart[];
  readonly tools: readonly ModelTool[];
  readonly execute: ToolExecutor;
  readonly maxSteps: number;
  readonly maxToolCalls: number;
  readonly maxTokens?: number;
}

export interface ToolLoopOutcome {
  /** The model's closing statement, filtered. */
  readonly summary: string;
  readonly toolCalls: number;
  /** Set when the loop stopped for a reason other than the model finishing. */
  readonly haltReason?: string;
}

export interface ModelProvider {
  /** Identifies the binding in logs and on the task record. */
  readonly id: string;
  readonly model: string;
  /** False for the scripted provider, so callers can state what produced a plan. */
  readonly callsExternalService: boolean;

  generateStructured<T>(request: StructuredRequest<T>): Promise<ModelResult<T>>;
  runToolLoop(request: ToolLoopRequest): Promise<ModelResult<ToolLoopOutcome>>;
}

export const MODEL_PROVIDER = 'MODEL_PROVIDER';

/** Raised when a provider fails in a way the agent should report, not retry. */
export class ModelProviderError extends Error {
  constructor(
    readonly provider: string,
    message: string,
    readonly retryable: boolean = false,
    /**
     * The HTTP status, when the failure had one.
     *
     * Kept because the failover chain decides move-on from stop by it, and this
     * class is where the status stops being available: toProviderError reads it,
     * uses it, and used to construct this error without it.
     */
    readonly statusCode?: number,
    /**
     * True when the provider answered but its response could not be parsed or
     * validated against the requested schema.
     *
     * Kept for the same reason as `statusCode`: the failover chain decides
     * move-on from stop by it, and this class is where the SDK's own error name
     * (`NoObjectGeneratedError`) stops being visible. Endpoints differ in this
     * capability — an agent-backed endpoint answers a large schema in prose
     * where a model endpoint returns the object — so it is a fact about this
     * provider rather than about the request.
     */
    readonly schemaMismatch: boolean = false,
  ) {
    super(message);
    this.name = 'ModelProviderError';
  }
}
