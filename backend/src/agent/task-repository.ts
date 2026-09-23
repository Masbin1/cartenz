import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { DatabaseService } from '../core/database/database.service';
import { withSequenceRetry } from '../core/database/task-sequence';
import {
  agentActions,
  agentTasks,
  approvals,
  projectConnections,
  projectEnvironments,
  projects,
} from '../core/database/schema';
import { AuditService } from '../core/audit/audit.service';
import { AUDIT_EVENTS } from '../core/audit/audit-events';
import { TaskEventPublisher } from '../core/events/task-event-publisher.service';
import { resolveAgentPermissions, type AgentPermission } from '../core/authz/agent-permissions';
import {
  GIT_CONNECTION_TYPES,
  type AgentTaskKind,
  type GitTransport,
  type OdooEdition,
  type ProjectType,
} from '../core/enums';
import { assertTransition, isTerminalStatus, type AgentTaskStatus } from './task-state';
import { executionModeFor, type ExecutionMode } from './executors/execution-mode';
import type { ImplementationPlan, ModifiedFile, TaskTestResults } from './orchestration/agent-plan';
import { GitCredentialsService } from '../modules/settings/git-credentials.service';
import { effectiveRepositoryUrl, applyTransportToUrl } from '../modules/projects/repository-url';

/** Everything a workflow step needs about a task, read in one query. */
export interface TaskExecutionSnapshot {
  readonly taskId: string;
  readonly reference: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly projectType: ProjectType;
  /**
   * The execution mode this task runs in, derived from the project type (ADR-028).
   * Null for a project type with no execution surface, such as an `ai_project`.
   */
  readonly executionMode: ExecutionMode | null;
  readonly prompt: string;
  /**
   * Documents attached to the task (ADR-030). Their text is passed to the model
   * as prompt parts; the workflow resolves the ids to text, the snapshot only
   * carries the ids so a later deletion does not change what was submitted.
   */
  readonly attachedDocumentIds: readonly string[];
  /** Which product shape this task is: a development run or a conversation (ADR-029). */
  readonly kind: AgentTaskKind;
  readonly status: AgentTaskStatus;
  readonly branch: string | null;
  /**
   * The commit the change is based on, saved during analysis and used to diff.
   * Null before the task has analysed once, which is how a resumed on-premise
   * task is told apart from a first allocation.
   */
  readonly baseCommit: string | null;
  /**
   * The commit this task has already created, once it has created one.
   *
   * Saved by the commit step. It is what the push is verified against: a push
   * that reported success without putting this commit on the remote is a lost
   * change wearing the costume of a delivered one.
   */
  readonly commitHash: string | null;
  readonly odooVersion: string | null;
  /** The project's Odoo edition (ADR-037). Governs which source the agent reads. */
  readonly odooEdition: OdooEdition;
  readonly repositoryUrl: string | null;
  readonly defaultBranch: string;
  /**
   * Secret reference for the repository credential, taken from the project's
   * first credential-bearing connection. The value is never in the snapshot: the
   * workspace manager unseals it at the moment of the clone (ADR-014).
   */
  readonly credentialRef: string | null;
  /** What that credential is: a token for HTTPS, or an SSH key (ADR-021). */
  readonly credentialKind: 'token' | 'ssh_key';
  /** Recorded host key for the remote, where one is held. */
  readonly sshHostKey: string | null;
  /** The account to present with a token over HTTPS (ADR-059). */
  readonly credentialUsername: string | null;
  /**
   * The environment this task targets, and the branch that is (ADR-021).
   *
   * Separate from `defaultBranch`, which is a repository fact. The target is a
   * choice, and it is never a production environment - task creation refuses that.
   */
  readonly targetBranch: string;
  readonly targetEnvironment: { name: string; kind: string } | null;
  /**
   * For an on-premise project, the selected local custom-module directory
   * (ADR-028). Null for every other mode.
   */
  readonly onPremiseProjectPath: string | null;
  /**
   * For odoo_online: the instance root, from the project's `odoo_api` connection.
   *
   * The URL only. The API key stays sealed and is unsealed by the Odoo tools at
   * the moment they call, so it never enters a snapshot, a prompt or a log.
   */
  readonly odooOnlineUrl: string | null;
  readonly plan: ImplementationPlan | null;
  readonly agentPermissions: Record<AgentPermission, boolean>;
  /** Only on-host models for this project (ADR-055). */
  readonly localProviderOnly: boolean;
  readonly grantedApprovals: readonly string[];
  /** Action of the approval still awaiting a decision, if any. */
  readonly pendingApproval: string | null;
  /**
   * The most recently decided approval. This is what tells a resumed workflow
   * where to continue from waiting_approval: the plan gate resumes into
   * implementing, the push gate into pushing.
   */
  readonly lastDecision: { readonly action: string; readonly status: string } | null;
}

/**
 * The only writer of agent task status.
 *
 * Concentrating the writes here is what makes the state machine enforceable:
 * `transition` is the sole path, it calls assertTransition, and it appends the
 * transition to the action log and publishes the event in the same call. A caller
 * cannot change a status without the audit trail and the event stream following.
 *
 * The status is re-read inside the same statement that updates it, using a
 * conditional WHERE, so two workers cannot both believe they made the same
 * transition.
 */
@Injectable()
export class TaskRepository {
  private readonly logger = new Logger(TaskRepository.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly events: TaskEventPublisher,
    private readonly audit: AuditService,
    private readonly gitCredentials: GitCredentialsService,
  ) {}

  async snapshot(taskId: string): Promise<TaskExecutionSnapshot> {
    const [row] = await this.database.db
      .select({
        taskId: agentTasks.id,
        reference: agentTasks.reference,
        projectId: agentTasks.projectId,
        projectName: projects.name,
        prompt: agentTasks.prompt,
        attachedDocumentIds: agentTasks.attachedDocumentIds,
        kind: agentTasks.kind,
        status: agentTasks.status,
        branch: agentTasks.branch,
        baseCommit: agentTasks.baseCommit,
        commitHash: agentTasks.commitHash,
        plan: agentTasks.plan,
        odooVersion: projects.odooVersion,
        odooEdition: projects.odooEdition,
        repositoryUrl: projects.repositoryUrl,
        defaultBranch: projects.defaultBranch,
        projectType: projects.projectType,
        agentPermissions: projects.agentPermissions,
        localProviderOnly: projects.localProviderOnly,
        environmentConfig: projects.environmentConfig,
        environmentId: agentTasks.environmentId,
        gitTransport: projects.gitTransport,
        gitCredentialId: projects.gitCredentialId,
        gitUsername: projects.gitUsername,
      })
      .from(agentTasks)
      .innerJoin(projects, eq(projects.id, agentTasks.projectId))
      .where(eq(agentTasks.id, taskId))
      .limit(1);

    if (!row) throw new NotFoundException(`Task ${taskId} not found`);

    /**
     * The credential a clone or a push uses (ADR-021, ADR-059).
     *
     * Resolved in three tiers, in this order:
     *
     *  1. The project's own choice, when its settings name one. This is the
     *     override an operator sets on the project's Git access panel, and it
     *     wins because it is the most specific statement of intent.
     *  2. The project's first credential-bearing Git connection. Restricted to
     *     connection types that *are* a Git remote (ADR-041): a project can hold
     *     more than one connection - an Odoo Online API key for `odoo_api`, a
     *     repository for `github` - and "the first one with a secret" stops being
     *     an answer once one of them is not a Git credential at all, because the
     *     push would present an Odoo API key to GitHub. Among the qualifying
     *     connections the oldest wins, as it did before.
     *  3. The deployment default registered for the remote's host (ADR-058).
     *
     * Tier 3 is what makes a project connectable without pasting a key into it:
     * before it, a project whose remote was reached with the deployment's own
     * key still had a null `credentialRef` here, and the push ran with no
     * credential at all - `could not read Username for 'https://github.com'`
     * when the remote was HTTPS.
     */
    const credential = await this.resolveCredential({
      projectId: row.projectId,
      repositoryUrl: row.repositoryUrl,
      gitCredentialId: row.gitCredentialId,
      gitUsername: row.gitUsername,
    });

    /**
     * The environment this task targets.
     *
     * Recorded on the task at creation, so a change to the project's environments
     * afterwards does not silently redirect a task that is already running.
     */
    const [environment] = row.environmentId
      ? await this.database.db
          .select({
            name: projectEnvironments.name,
            branch: projectEnvironments.branch,
            kind: projectEnvironments.kind,
          })
          .from(projectEnvironments)
          .where(eq(projectEnvironments.id, row.environmentId))
          .limit(1)
      : [];

    const allApprovals = await this.database.db
      .select({
        action: approvals.action,
        status: approvals.status,
        decidedAt: approvals.decidedAt,
      })
      .from(approvals)
      .where(eq(approvals.taskId, taskId))
      .orderBy(approvals.requestedAt);

    const granted = allApprovals.filter((entry) => entry.status === 'approved');
    const pending = allApprovals.find((entry) => entry.status === 'pending') ?? null;
    const decided = allApprovals
      .filter((entry) => entry.status !== 'pending' && entry.decidedAt !== null)
      .sort((a, b) => (a.decidedAt as Date).getTime() - (b.decidedAt as Date).getTime());
    const lastDecision = decided.length > 0 ? decided[decided.length - 1] : null;

    // Read once: it decides both the execution mode (ADR-036: an ai_project with
    // a local directory runs on-premise) and is reported to the workspace layer.
    const onPremiseProjectPath = readOnPremisePath(row.environmentConfig);

    /**
     * The URL the workspace clones from and pushes to (ADR-041, ADR-059).
     *
     * Resolved from both places a repository URL can be recorded, and then
     * rewritten to match this project's chosen transport. Reading only
     * `projects.repository_url` is the ADR-041 mistake in miniature: a project
     * whose URL lives on its connection looks repository-less here, and the clone
     * is skipped with "no repository connected" naming an action the operator has
     * no reason to take. Applying the transport on top is what makes the setting
     * on the project's Git access panel reach the git command that actually runs.
     */
    const repositoryUrl = this.repositoryUrlFor(
      row.repositoryUrl,
      credential.connections,
      row.gitTransport,
    );

    return {
      taskId: row.taskId,
      reference: row.reference,
      projectId: row.projectId,
      projectName: row.projectName,
      projectType: row.projectType as ProjectType,
      executionMode: executionModeFor(row.projectType as ProjectType, {
        hasLocalDirectory: onPremiseProjectPath !== null,
        // A connected project with a repository is repo-backed (ADR-050): it
        // clones the branch rather than operating on the local directory.
        hasRepository: repositoryUrl !== null,
      }),
      prompt: row.prompt,
      attachedDocumentIds: row.attachedDocumentIds ?? [],
      kind: row.kind as AgentTaskKind,
      status: row.status as AgentTaskStatus,
      branch: row.branch,
      baseCommit: row.baseCommit,
      commitHash: row.commitHash,
      odooVersion: row.odooVersion,
      odooEdition: row.odooEdition as OdooEdition,
      repositoryUrl,
      defaultBranch: row.defaultBranch,
      credentialRef: credential.secretRef,
      /**
       * The kind of the credential actually resolved, not the connection's.
       *
       * A project using the deployment default has no connection to read it
       * from, and defaulting to `token` there is what made an SSH-key project
       * present a token to an SSH remote. The resolver knows which kind it
       * returned; this reports that.
       */
      credentialKind: credential.credentialKind,
      sshHostKey: credential.sshHostKey,
      credentialUsername: credential.credentialUsername,
      targetBranch: environment?.branch ?? row.defaultBranch,
      targetEnvironment: environment
        ? { name: environment.name, kind: environment.kind }
        : null,
      onPremiseProjectPath,
      odooOnlineUrl: readOdooOnlineUrl(credential.connectionMetadata),
      plan: (row.plan as ImplementationPlan | null) ?? null,
      agentPermissions: resolveAgentPermissions(row.agentPermissions),
      localProviderOnly: row.localProviderOnly,
      grantedApprovals: granted.map((entry) => entry.action),
      pendingApproval: pending?.action ?? null,
      lastDecision: lastDecision
        ? { action: lastDecision.action, status: lastDecision.status }
        : null,
    };
  }

  /**
   * Resolves the credential a clone or a push uses (ADR-021, ADR-059).
   *
   * See `snapshot`'s comment for the three-tier order. This is its own method
   * because both `snapshot` and a settings read need the same order applied,
   * and a second implementation is how the two would quietly drift.
   */
  private async resolveCredential(input: {
    readonly projectId: string;
    readonly repositoryUrl: string | null;
    readonly gitCredentialId: string | null;
    /** The project's own username override for a token (ADR-059). */
    readonly gitUsername: string | null;
  }): Promise<{
    readonly secretRef: string | null;
    readonly credentialKind: 'token' | 'ssh_key';
    readonly sshHostKey: string | null;
    readonly credentialUsername: string | null;
    readonly connectionMetadata: Record<string, unknown> | null;
    readonly connections: readonly {
      connectionType: string;
      metadata: Record<string, unknown> | null;
    }[];
  }> {
    const connections = await this.database.db
      .select({
        secretRef: projectConnections.secretRef,
        credentialKind: projectConnections.credentialKind,
        sshHostKey: projectConnections.sshHostKey,
        metadata: projectConnections.metadata,
        connectionType: projectConnections.connectionType,
        createdAt: projectConnections.createdAt,
      })
      .from(projectConnections)
      .where(eq(projectConnections.projectId, input.projectId))
      .orderBy(projectConnections.createdAt);

    // The repository URL's own metadata is read here regardless of which tier
    // supplies the credential: an Odoo Online URL, in particular, lives on the
    // connection even when tier 1 or tier 3 is what authenticates the push.
    const connectionMetadata = connections[0]?.metadata ?? null;

    if (input.gitCredentialId) {
      const registered = await this.gitCredentials
        .resolveForHost({ credentialId: input.gitCredentialId })
        .catch(() => null);
      if (registered) {
        return {
          secretRef: registered.secretRef,
          credentialKind: registered.kind,
          sshHostKey: null,
          credentialUsername: input.gitUsername,
          connectionMetadata,
          connections,
        };
      }
      // A project-level choice that no longer resolves (the row was deleted or
      // disabled after being chosen) falls through to the next tier rather than
      // failing the whole snapshot - the same recovery a null credential column
      // always had.
    }

    const gitConnection = connections.find(
      (row) =>
        row.secretRef !== null &&
        (GIT_CONNECTION_TYPES as readonly string[]).includes(row.connectionType),
    );
    if (gitConnection) {
      return {
        secretRef: gitConnection.secretRef,
        credentialKind: gitConnection.credentialKind as 'token' | 'ssh_key',
        sshHostKey: gitConnection.sshHostKey,
        credentialUsername: input.gitUsername,
        connectionMetadata,
        connections,
      };
    }

    const host = input.repositoryUrl ? this.gitCredentials.hostOf(input.repositoryUrl) : null;
    const registeredDefault = await this.gitCredentials
      .resolveForHost({ host })
      .catch(() => null);

    return {
      secretRef: registeredDefault?.secretRef ?? null,
      credentialKind: registeredDefault?.kind ?? 'token',
      sshHostKey: null,
      credentialUsername: input.gitUsername,
      connectionMetadata,
      connections,
    };
  }

  /**
   * The repository URL a clone or a push uses (ADR-041, ADR-059).
   *
   * The project's own column when set; otherwise the first Git connection's
   * metadata (ADR-041). Then rewritten to the project's chosen transport, so a
   * project set to HTTPS never hands git an `ssh://` remote regardless of which
   * of the two places recorded it.
   */
  private repositoryUrlFor(
    ownUrl: string | null,
    connections: readonly { connectionType: string; metadata: Record<string, unknown> | null }[],
    gitTransport: string,
  ): string | null {
    const resolved = effectiveRepositoryUrl(ownUrl, connections);
    if (!resolved) return null;
    return applyTransportToUrl(resolved, gitTransport as GitTransport);
  }

  async currentStatus(taskId: string): Promise<AgentTaskStatus> {
    const [row] = await this.database.db
      .select({ status: agentTasks.status })
      .from(agentTasks)
      .where(eq(agentTasks.id, taskId))
      .limit(1);

    if (!row) throw new NotFoundException(`Task ${taskId} not found`);
    return row.status as AgentTaskStatus;
  }

  /**
   * Moves a task to a new status.
   *
   * The transition is asserted against the state machine first, then applied with
   * a conditional update so that it only lands if the task is still in the state
   * the caller observed. If the update matches no row, another worker or a
   * cancellation moved the task, and the caller is told so rather than
   * proceeding on a stale view.
   */
  async transition(
    taskId: string,
    from: AgentTaskStatus,
    to: AgentTaskStatus,
    options: { message?: string; failureReason?: string } = {},
  ): Promise<boolean> {
    assertTransition(from, to, taskId);

    const patch: Record<string, unknown> = { status: to, updatedAt: new Date() };
    if (to === 'analyzing') patch.startedAt = new Date();
    if (isTerminalStatus(to)) patch.completedAt = new Date();
    if (options.failureReason) patch.failureReason = options.failureReason;

    const updated = await this.database.db
      .update(agentTasks)
      .set(patch)
      .where(and(eq(agentTasks.id, taskId), eq(agentTasks.status, from)))
      .returning({
        id: agentTasks.id,
        reference: agentTasks.reference,
        projectId: agentTasks.projectId,
      });

    if (updated.length === 0) {
      this.logger.warn(
        `Transition ${from} -> ${to} for task ${taskId} did not apply: the task is no longer in ${from}.`,
      );
      return false;
    }

    const { reference, projectId } = updated[0];

    await this.appendTransition(taskId, from, to);

    await this.events.publish({
      taskId,
      taskReference: reference,
      type: eventTypeForStatus(to),
      status: eventStatusForStatus(to),
      taskStatus: to,
      message: options.message ?? `Task ${reference} is now ${to.replace(/_/g, ' ')}`,
      payload: { from, to, ...(options.failureReason ? { reason: options.failureReason } : {}) },
    });

    await this.audit.record({
      event: auditEventForStatus(to),
      projectId,
      metadata: { taskReference: reference, from, to, reason: options.failureReason },
    });

    return true;
  }

  async savePlan(taskId: string, plan: ImplementationPlan): Promise<void> {
    await this.database.db
      .update(agentTasks)
      .set({ plan: plan as unknown as Record<string, unknown>, updatedAt: new Date() })
      .where(eq(agentTasks.id, taskId));
  }

  /** Stores the natural-language answer a chat task produced (ADR-029). */
  async saveAnswer(taskId: string, answer: string): Promise<void> {
    await this.database.db
      .update(agentTasks)
      .set({ answer, updatedAt: new Date() })
      .where(eq(agentTasks.id, taskId));
  }

  async saveBranch(taskId: string, branch: string): Promise<void> {
    await this.database.db
      .update(agentTasks)
      .set({ branch, updatedAt: new Date() })
      .where(eq(agentTasks.id, taskId));
  }

  async saveModifiedFiles(taskId: string, files: readonly ModifiedFile[]): Promise<void> {
    await this.database.db
      .update(agentTasks)
      .set({ modifiedFiles: [...files], updatedAt: new Date() })
      .where(eq(agentTasks.id, taskId));
  }

  async saveTestResults(taskId: string, results: TaskTestResults): Promise<void> {
    await this.database.db
      .update(agentTasks)
      .set({
        testResults: results as unknown as Record<string, unknown>,
        updatedAt: new Date(),
      })
      .where(eq(agentTasks.id, taskId));
  }

  async saveBaseCommit(taskId: string, baseCommit: string): Promise<void> {
    await this.database.db
      .update(agentTasks)
      .set({ baseCommit, updatedAt: new Date() })
      .where(eq(agentTasks.id, taskId));
  }

  async saveDiffStats(taskId: string, stats: Record<string, unknown>): Promise<void> {
    await this.database.db
      .update(agentTasks)
      .set({ diffStats: stats, updatedAt: new Date() })
      .where(eq(agentTasks.id, taskId));
  }

  /**
   * Stores the unified diff, truncated to a bound. The cap is applied here rather
   * than trusted from the caller, because this is the last point before the
   * database.
   */
  async saveDiffPatch(taskId: string, patch: string, maxBytes = 262144): Promise<void> {
    const bounded =
      patch.length > maxBytes
        ? `${patch.slice(0, maxBytes)}
... diff truncated at ${maxBytes} bytes ...
`
        : patch;

    await this.database.db
      .update(agentTasks)
      .set({ diffPatch: bounded, updatedAt: new Date() })
      .where(eq(agentTasks.id, taskId));
  }

  async saveCommitHash(taskId: string, commitHash: string): Promise<void> {
    await this.database.db
      .update(agentTasks)
      .set({ commitHash, updatedAt: new Date() })
      .where(eq(agentTasks.id, taskId));
  }

  /**
   * Records the agent's narration. Kept in the same append-only log as tool
   * calls so that reasoning and action are interleaved in one ordered record.
   */
  async appendReasoning(
    taskId: string,
    taskReference: string,
    taskStatus: AgentTaskStatus,
    message: string,
  ): Promise<void> {
    await withSequenceRetry(
      () =>
        this.database.db.insert(agentActions).values({
          taskId,
          sequence: sql`(
            select coalesce(max(a.sequence), 0) + 1
            from agent_actions a
            where a.task_id = ${taskId}
          )`,
          actionType: 'reasoning',
          status: 'succeeded',
          output: { message },
          simulated: true,
        }),
      'agent_actions_task_sequence_unique',
    );

    await this.events.publish({
      taskId,
      taskReference,
      type: 'agent_activity',
      status: 'running',
      taskStatus,
      message,
    });
  }

  /**
   * Allocates a candidate task reference in the documented task_9281 form.
   *
   * Generated rather than drawn from a sequence: a sequence would need its own
   * migration and would disclose the platform-wide task count to every
   * customer. The unique index on the column is the authority, and the caller
   * retries on collision.
   */
  candidateReference(): string {
    return `task_${randomInt(1000, 1000000)}`;
  }
  private async appendTransition(
    taskId: string,
    from: AgentTaskStatus,
    to: AgentTaskStatus,
  ): Promise<void> {
    await withSequenceRetry(
      () =>
        this.database.db.insert(agentActions).values({
          taskId,
          sequence: sql`(
            select coalesce(max(a.sequence), 0) + 1
            from agent_actions a
            where a.task_id = ${taskId}
          )`,
          actionType: 'transition',
          status: 'succeeded',
          input: { from },
          output: { to },
          simulated: false,
        }),
      'agent_actions_task_sequence_unique',
    );
  }

  /** Only pending tasks may be listed for cancellation and resumption. */
  async listActiveForProject(projectId: string) {
    return this.database.db
      .select({ id: agentTasks.id, status: agentTasks.status })
      .from(agentTasks)
      .where(
        and(
          eq(agentTasks.projectId, projectId),
          isNull(agentTasks.completedAt),
        ),
      );
  }
}

/**
 * Maps a task status to the realtime event type that announces it.
 *
 * `task_status_changed` is the general case; the specific types documented in
 * chapter 15 are used where one exists, so a client can either handle the
 * specific events or fall back to the general one.
 */
function eventTypeForStatus(status: AgentTaskStatus) {
  switch (status) {
    case 'analyzing':
      return 'task_started' as const;
    case 'waiting_approval':
      return 'approval_required' as const;
    case 'testing':
      return 'test_started' as const;
    case 'completed':
      return 'task_completed' as const;
    case 'failed':
      return 'task_failed' as const;
    default:
      return 'task_status_changed' as const;
  }
}

function eventStatusForStatus(status: AgentTaskStatus) {
  if (status === 'completed') return 'succeeded' as const;
  if (status === 'failed' || status === 'cancelled') return 'failed' as const;
  if (status === 'waiting_approval') return 'pending' as const;
  return 'running' as const;
}

function auditEventForStatus(status: AgentTaskStatus) {
  switch (status) {
    case 'analyzing':
      return AUDIT_EVENTS.TASK_STARTED;
    case 'completed':
      return AUDIT_EVENTS.TASK_COMPLETED;
    case 'failed':
      return AUDIT_EVENTS.TASK_FAILED;
    case 'cancelled':
      return AUDIT_EVENTS.TASK_CANCELLED;
    default:
      return AUDIT_EVENTS.TASK_TRANSITIONED;
  }
}

/**
 * The selected local directory for an on-premise project, stored in the project's
 * environment configuration. Null when absent or not a string.
 */
function readOnPremisePath(
  environmentConfig: Record<string, unknown> | null | undefined,
): string | null {
  if (!environmentConfig || typeof environmentConfig !== 'object') return null;
  const value = environmentConfig.onPremisePath;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The Odoo Online instance root, from the connection's metadata.
 *
 * The URL is not secret and the plan needs it, so a reviewer can see which
 * instance a change is about to be made on. The API key alongside it is a sealed
 * reference and is deliberately not read here.
 */
function readOdooOnlineUrl(metadata: Record<string, unknown> | null | undefined): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const value = metadata.url;
  return typeof value === 'string' && value.length > 0 ? value : null;
}
