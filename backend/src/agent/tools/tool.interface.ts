import type { AgentPermission } from '../../core/authz/agent-permissions';

/**
 * The tool contract (chapter 7).
 *
 * The agent never touches a filesystem, a shell, Git or Odoo directly. It emits
 * a tool request; the platform validates it and executes it. This interface is
 * that boundary, and it is the only way an agent-initiated effect can occur.
 *
 * Every tool declares the single agent permission it needs. A tool cannot be
 * registered without one, so there is no path by which a capability reaches the
 * execution layer without a corresponding permission having been checked.
 */
export interface ToolDefinition<
  TInput = Record<string, unknown>,
  TOutput extends Record<string, unknown> = Record<string, unknown>,
> {
  /** Documented tool name, e.g. `read_file`. Unique across the registry. */
  readonly name: string;

  /** One-line description, shown in the activity timeline. */
  readonly description: string;

  /** The permission this tool requires. Checked before every execution. */
  readonly permission: AgentPermission;

  /**
   * Whether this tool's effects leave the platform boundary. Used by the policy
   * layer to decide whether an approval is required, independently of whether
   * the permission itself is approval-bearing.
   */
  readonly leavesPlatform: boolean;

  /**
   * True while the implementation simulates its effect (ADR-013). Recorded on
   * every action so the audit trail distinguishes a simulated result from a real
   * one.
   */
  readonly simulated: boolean;

  /**
   * JSON Schema for the tool's arguments, as a model needs to see it (ADR-020).
   *
   * Declared alongside `validate` rather than derived from it, and the two are
   * not the same thing. The schema is a description sent to a model, which may
   * ignore it; `validate` is the platform's own check and is what actually
   * refuses a call. A tool is safe if `validate` is right, whatever the schema
   * says.
   */
  readonly parameters: Record<string, unknown>;

  /**
   * Whether a model may choose this tool.
   *
   * False for the tools the workflow drives itself - branching, committing,
   * pushing and validation happen at defined points in the lifecycle, and letting
   * a model call them would let it commit before its work had been reviewed.
   */
  readonly availableToModel: boolean;

  /**
   * Validates the request. Returning a message rejects the call before
   * execution; returning null accepts it. Kept separate from execute so a
   * malformed request is refused without any effect having begun.
   */
  validate(input: unknown): string | null;

  execute(input: TInput, context: ToolExecutionContext): Promise<TOutput>;
}

/**
 * What a tool is told about the task it is serving. Deliberately narrow: a tool
 * receives no credentials, no user identity and no database handle. Anything it
 * needs to reach an external system it must request through the platform.
 */
export interface ToolExecutionContext {
  readonly taskId: string;
  readonly taskReference: string;
  readonly projectId: string;
  readonly organizationId: string;
  readonly workspace: {
    readonly workspaceId: string;
    /**
     * Absolute path of the clone. A tool resolves every path it is given against
     * this, through resolveExistingPath or resolveWritablePath - never by
     * joining strings itself (ADR-019).
     */
    readonly repositoryPath: string;
    readonly branch: string;
    readonly baseBranch: string;
    readonly baseCommit: string | null;
    readonly repositoryUrl: string | null;
    readonly odooVersion: string | null;
    /** True when no repository was cloned, so the file tools have nothing to read. */
    readonly simulated: boolean;
  };
}

/** The result of a mediated tool call, as recorded and published. */
export interface ToolExecutionResult {
  readonly toolName: string;
  readonly status: 'succeeded' | 'failed' | 'denied';
  readonly output: Record<string, unknown> | null;
  readonly denialReason?: string;
  readonly durationMs: number;
  readonly simulated: boolean;
}

/**
 * A tool of any input shape, for the registry and for collections of tools.
 *
 * The registry holds heterogeneous tools whose input types differ, so it cannot
 * be typed over a single TInput. Validation is the mechanism that makes this
 * safe: the registry calls `validate` before `execute`, so an input that does
 * not match the tool's expectation is refused before it reaches the
 * implementation.
 */
/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
export type AnyToolDefinition = ToolDefinition<any, Record<string, unknown>>;
