import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { DatabaseService } from '../../core/database/database.service';
import {
  agentActions,
  agentSessions,
  agentTaskEvents,
  agentTasks,
  projectConnections,
  projectDocuments,
  projectEnvironments,
  approvals,
  projects,
} from '../../core/database/schema';
import { AuthorizationService } from '../../core/authz/authorization.service';
import { AuditService } from '../../core/audit/audit.service';
import { AUDIT_EVENTS } from '../../core/audit/audit-events';
import { TaskRepository } from '../../agent/task-repository';
import { ToolRegistry } from '../../agent/tools/tool-registry';
import { ModelCallRecorder } from '../../agent/model/model-call-recorder.service';
import { ProjectEnvironmentsService } from '../projects/project-environments.service';
import {
  AGENT_ORCHESTRATOR,
  type AgentOrchestrator,
} from '../../agent/orchestration/agent-orchestrator.interface';
import { isTerminalStatus, type AgentTaskStatus } from '../../agent/task-state';
import { REPOSITORY_BACKED_PROJECT_TYPES, GIT_CONNECTION_TYPES, type AgentTaskKind, type ProjectType } from '../../core/enums';
import type { AuthenticatedUser } from '../../core/authz/authenticated-user';
import type { CreateTaskDto } from './dto/task.dto';

/** `count(*)`, typed for the grouped session query below. */
const sqlCount = () => sql<number>`count(*)`;
/** `max(created_at)`, typed for the grouped session query below. */
const sqlMaxCreatedAt = () => sql<Date>`max(${agentTasks.createdAt})`;

/**
 * Agent sessions and tasks.
 *
 * Creating a task writes the record and enqueues the work; it does not wait for
 * the agent. The response is the task identifier and its initial status, exactly
 * as chapter 15 specifies, so the API stays responsive while a task runs for
 * minutes.
 */
@Injectable()
export class TasksService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService,
    private readonly taskRepository: TaskRepository,
    private readonly registry: ToolRegistry,
    private readonly modelCalls: ModelCallRecorder,
    private readonly environments: ProjectEnvironmentsService,
    @Inject(AGENT_ORCHESTRATOR) private readonly orchestrator: AgentOrchestrator,
  ) {}

  /**
   * The Git connection a workspace would take its credential from, or null.
   *
   * The same query `TaskRepository` runs to build a task's snapshot, kept in step
   * with it deliberately: the question a development request has to answer is
   * "will the workspace have a credential?", and answering it against a different
   * filter than the one that supplies the credential is how a project with a
   * perfectly good GitHub connection got refused (ADR-041).
   *
   * The oldest qualifying connection wins, as it does there, and only connection
   * types that are Git remotes qualify — an `odoo_api` secret authenticates an
   * HTTP API and is not a clone credential.
   */
  private async gitConnectionFor(projectId: string) {
    const [connection] = await this.database.db
      .select({ id: projectConnections.id })
      .from(projectConnections)
      .where(
        and(
          eq(projectConnections.projectId, projectId),
          isNotNull(projectConnections.secretRef),
          inArray(projectConnections.connectionType, [...GIT_CONNECTION_TYPES]),
        ),
      )
      .orderBy(projectConnections.createdAt)
      .limit(1);

    return connection ?? null;
  }

  async create(user: AuthenticatedUser, projectId: string, dto: CreateTaskDto) {
    // Which product shape this task is (ADR-029). `change` is the existing
    // development run; `chat` answers a question and never commits or pushes.
    const kind: AgentTaskKind = dto.kind ?? 'change';

    const context = await this.authz.requireProjectAccess(user, projectId);

    const [project] = await this.database.db
      .select({
        projectType: projects.projectType,
        repositoryUrl: projects.repositoryUrl,
        name: projects.name,
      })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    if (!project) throw new NotFoundException('Project not found');

    /**
     * A repository-backed project with no repository cannot be worked on at all.
     *
     * Checked here rather than discovered by the workflow, because the alternative
     * is worse than it sounds: the task would clone nothing, plan anyway, ask a
     * person to approve that plan, and only then fail because there is nothing to
     * modify. Refusing at submission tells the user the one thing they need to do.
     *
     * `on_premise` and `odoo_online` have no repository by design: the first
     * operates on a local directory, the second on the Odoo instance. They fall
     * through; their own surface is validated at workspace allocation or by the
     * Odoo Online tools.
     *
     * An `ai_project` is not repository-backed, and creation gives it a GitHub
     * repository without recording it on `projects.repository_url`: the repository
     * is recorded as the project's `github` *connection*, which is where a task's
     * credential comes from. Reading only `repository_url` therefore refused
     * development requests on exactly the projects this platform had just finished
     * giving a repository to, and named a connection that was already connected
     * (ADR-041). So this branch asks whether the project has a Git connection
     * before it asks whether it has a repository URL.
     *
     * A `chat` task on an `ai_project` is allowed despite the missing repository
     * (ADR-029): it needs nothing to clone, and answers from the project
     * specification. A `chat` on a repository-backed project still requires the
     * repository, because reading it is how the agent answers.
     */
    const hasGitConnection =
      project.projectType === 'ai_project'
        ? (await this.gitConnectionFor(projectId)) !== null
        : false;

    if (
      kind !== 'chat' &&
      !project.repositoryUrl &&
      !hasGitConnection &&
      project.projectType === 'ai_project'
    ) {
      throw new BadRequestException(
        'This project was created from a specification and has no repository yet. ' +
          'Connect one before submitting a development request.',
      );
    }

    if (!project.repositoryUrl && REPOSITORY_BACKED_PROJECT_TYPES.includes(
      project.projectType as ProjectType,
    )) {
      throw new BadRequestException(
        'This project has no repository connected. Connect one in the project settings before submitting a task.',
      );
    }

    if (context.agentPermissions.repository_read !== true) {
      throw new BadRequestException(
        'The agent is not permitted to read this project. Enable repository read in the project settings.',
      );
    }

    /**
     * Documents attached to this task (ADR-030) must already exist on this
     * project. Validated at submission so a mistyped id fails the request rather
     * than silently running without the document the person meant to attach.
     */
    const attachedDocumentIds = await this.resolveAttachedDocuments(
      projectId,
      dto.documentIds ?? [],
    );

    /**
     * The environment this task will work against (ADR-021).
     *
     * Resolved and refused here, before a session is opened or a task row is
     * written, so a task targeting production leaves no trace beyond the refusal
     * itself. On Odoo.sh the production branch is the live business.
     */
    const environment = await this.environments.resolveTarget(
      projectId,
      dto.environmentId,
      user.userId,
    );

    /**
     * Neither Odoo.sh nor on-premise is worked on the `main` branch (ADR-028: "the
     * platform never pushes to main"). The branch is the live business, so it is
     * refused outright rather than gated: if the repository only has `main`, the
     * person must ask the project administrator to create another branch before
     * anything can be submitted.
     *
     * On-premise is included because it commits directly in the directory a person
     * selected, on the environment's own branch. There is no separate AI branch
     * standing between the agent's commit and `main`, which makes the restriction
     * matter more there than on Odoo.sh, not less.
     *
     * A `chat` task skips this refusal (ADR-029): it never commits or pushes, so
     * targeting the branch a person is on is harmless - the agent only reads it.
     */
    if (
      kind !== 'chat' &&
      (project.projectType === 'odoo_sh' || project.projectType === 'on_premise') &&
      environment.branch === 'main'
    ) {
      // The refusal is audited before it is raised (ADR-028: "the task is
      // refused before any row is written, and the refusal is audited"). Written
      // first so that a refusal nobody can see is not indistinguishable from a
      // request nobody made; mirrors ADR-021's production refusal, reusing the
      // same event with a reason that names this decision.
      await this.audit.record({
        event: AUDIT_EVENTS.ENVIRONMENT_TARGET_REFUSED,
        projectId,
        userId: user.userId,
        metadata: {
          environmentId: environment.id,
          environmentName: environment.name,
          environmentKind: environment.kind,
          branch: environment.branch,
          projectType: project.projectType,
          reason: 'the main branch is the live business and is not targetable (ADR-028)',
        },
      });

      throw new BadRequestException(
        `${project.projectType === 'odoo_sh' ? 'Odoo.sh' : 'On-premise'} projects cannot target ` +
          'the main branch. Ask the project administrator to create another branch.',
      );
    }

    const sessionId = dto.sessionId
      ? await this.assertSessionBelongsToProject(dto.sessionId, projectId)
      : await this.openSession(projectId, user.userId, dto.prompt);

    const task = await this.insertTask({
      projectId,
      sessionId,
      createdByUserId: user.userId,
      prompt: dto.prompt,
      kind,
      environmentId: environment.id,
      attachedDocumentIds,
    });

    await this.audit.record({
      event: AUDIT_EVENTS.TASK_CREATED,
      projectId,
      userId: user.userId,
      metadata: {
        taskReference: task.reference,
        promptLength: dto.prompt.length,
        environment: environment.name,
        environmentKind: environment.kind,
        branch: environment.branch,
      },
    });

    // Enqueue after the record is committed, so the worker cannot read a task
    // that does not yet exist.
    await this.orchestrator.start(task.id);

    return {
      task_id: task.reference,
      id: task.id,
      status: task.status,
      sessionId,
      environment: {
        id: environment.id,
        name: environment.name,
        kind: environment.kind,
        branch: environment.branch,
      },
    };
  }

  async listForProject(
    user: AuthenticatedUser,
    projectId: string,
    limit = 50,
    sessionId?: string,
  ) {
    await this.authz.requireProjectAccess(user, projectId);

    // A session id narrows the list to one conversation (ADR-047). The
    // session's own project is checked rather than trusted, so a valid id from
    // another project reads nothing rather than another project's tasks.
    if (sessionId) await this.assertSessionBelongsToProject(sessionId, projectId);

    return this.database.db
      .select({
        id: agentTasks.id,
        reference: agentTasks.reference,
        sessionId: agentTasks.sessionId,
        prompt: agentTasks.prompt,
        kind: agentTasks.kind,
        status: agentTasks.status,
        answer: agentTasks.answer,
        branch: agentTasks.branch,
        commitHash: agentTasks.commitHash,
        simulated: agentTasks.simulated,
        createdAt: agentTasks.createdAt,
        startedAt: agentTasks.startedAt,
        completedAt: agentTasks.completedAt,
      })
      .from(agentTasks)
      .where(
        sessionId
          ? and(eq(agentTasks.projectId, projectId), eq(agentTasks.sessionId, sessionId))
          : eq(agentTasks.projectId, projectId),
      )
      // Oldest first when reading one session: it is a conversation, and a
      // conversation is read downwards. The unfiltered list stays newest-first,
      // which is what a "most recent work" listing should be.
      .orderBy(sessionId ? agentTasks.createdAt : desc(agentTasks.createdAt))
      .limit(Math.min(limit, 200));
  }

  /** Full task detail: plan, files, tests, actions and pending approval. */
  async findOne(user: AuthenticatedUser, taskId: string) {
    const [task] = await this.database.db
      .select()
      .from(agentTasks)
      .where(eq(agentTasks.id, taskId))
      .limit(1);

    if (!task) throw new NotFoundException('Task not found');

    await this.authz.requireProjectAccess(user, task.projectId);

    const [environment] = task.environmentId
      ? await this.database.db
          .select({
            id: projectEnvironments.id,
            name: projectEnvironments.name,
            branch: projectEnvironments.branch,
            kind: projectEnvironments.kind,
          })
          .from(projectEnvironments)
          .where(eq(projectEnvironments.id, task.environmentId))
          .limit(1)
      : [];

    const actions = await this.database.db
      .select({
        id: agentActions.id,
        sequence: agentActions.sequence,
        actionType: agentActions.actionType,
        toolName: agentActions.toolName,
        status: agentActions.status,
        output: agentActions.output,
        denialReason: agentActions.denialReason,
        simulated: agentActions.simulated,
        durationMs: agentActions.durationMs,
        createdAt: agentActions.createdAt,
      })
      .from(agentActions)
      .where(eq(agentActions.taskId, taskId))
      .orderBy(agentActions.sequence);

    const taskApprovals = await this.database.db
      .select()
      .from(approvals)
      .where(eq(approvals.taskId, taskId))
      .orderBy(desc(approvals.requestedAt));

    // What produced the plan, and what the AI data boundary removed on the way
    // out. Shown in the portal so a reviewer can weigh the plan accordingly.
    const modelCalls = await this.modelCalls.listForTask(taskId);

    return {
      id: task.id,
      reference: task.reference,
      projectId: task.projectId,
      sessionId: task.sessionId,
      prompt: task.prompt,
      kind: task.kind,
      status: task.status,
      branch: task.branch,
      commitHash: task.commitHash,
      answer: task.answer,
      plan: task.plan,
      modifiedFiles: task.modifiedFiles,
      baseCommit: task.baseCommit,
      // Named rather than implied: the same prompt against staging and against a
      // development branch are different requests.
      environment: environment ?? null,
      diffStats: task.diffStats,
      // The patch itself is served by GET /tasks/{id}/diff, not here.
      hasDiff: task.diffPatch !== null && task.diffPatch.length > 0,
      simulatedCapabilities: task.simulatedCapabilities,
      testResults: task.testResults,
      failureReason: task.failureReason,
      simulated: task.simulated,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      actions,
      approvals: taskApprovals,
      pendingApproval: taskApprovals.find((approval) => approval.status === 'pending') ?? null,
      modelCalls: modelCalls.map((call) => ({
        operation: call.operation,
        providerId: call.providerId,
        model: call.model,
        calledExternalService: call.calledExternalService,
        inputTokens: call.inputTokens,
        outputTokens: call.outputTokens,
        durationMs: call.durationMs,
        steps: call.steps,
        toolCalls: call.toolCalls,
        boundaryFindings: call.boundaryFindings,
        redactionCount: call.redactionCount,
        boundaryRefused: call.boundaryRefused,
        haltReason: call.haltReason,
        createdAt: call.createdAt,
      })),
    };
  }

  /**
   * The unified diff of a task's change.
   *
   * Served from the task record rather than regenerated, because the workspace is
   * destroyed when the run ends. Kept on its own endpoint rather than included in
   * the task detail: a patch can be a quarter of a megabyte, and the detail is
   * fetched on every event.
   */
  async diff(user: AuthenticatedUser, taskId: string) {
    const [task] = await this.database.db
      .select({
        projectId: agentTasks.projectId,
        reference: agentTasks.reference,
        branch: agentTasks.branch,
        baseCommit: agentTasks.baseCommit,
        commitHash: agentTasks.commitHash,
        diffStats: agentTasks.diffStats,
        diffPatch: agentTasks.diffPatch,
        modifiedFiles: agentTasks.modifiedFiles,
      })
      .from(agentTasks)
      .where(eq(agentTasks.id, taskId))
      .limit(1);

    if (!task) throw new NotFoundException('Task not found');
    await this.authz.requireProjectAccess(user, task.projectId);

    return {
      reference: task.reference,
      branch: task.branch,
      baseCommit: task.baseCommit,
      commitHash: task.commitHash,
      stats: task.diffStats,
      files: task.modifiedFiles,
      patch: task.diffPatch,
      available: task.diffPatch !== null && task.diffPatch.length > 0,
    };
  }

  /** Event history, for a client that connects after a task has begun. */
  async events(user: AuthenticatedUser, taskId: string) {
    const [task] = await this.database.db
      .select({ projectId: agentTasks.projectId })
      .from(agentTasks)
      .where(eq(agentTasks.id, taskId))
      .limit(1);

    if (!task) throw new NotFoundException('Task not found');
    await this.authz.requireProjectAccess(user, task.projectId);

    return this.database.db
      .select()
      .from(agentTaskEvents)
      .where(eq(agentTaskEvents.taskId, taskId))
      .orderBy(agentTaskEvents.sequence);
  }

  /**
   * Cancels a task. The status is written first and the queue is told afterwards,
   * because the status is what the workflow observes; a failure to reach the
   * queue delays the stop by one step rather than losing the cancellation.
   */
  async cancel(user: AuthenticatedUser, taskId: string, reason: string | undefined) {
    const [task] = await this.database.db
      .select({
        id: agentTasks.id,
        reference: agentTasks.reference,
        projectId: agentTasks.projectId,
        status: agentTasks.status,
      })
      .from(agentTasks)
      .where(eq(agentTasks.id, taskId))
      .limit(1);

    if (!task) throw new NotFoundException('Task not found');

    await this.authz.requireProjectAccess(user, task.projectId);
    const status = task.status as AgentTaskStatus;

    if (isTerminalStatus(status)) {
      throw new ConflictException(`This task has already ${status} and cannot be cancelled.`);
    }

    const applied = await this.taskRepository.transition(taskId, status, 'cancelled', {
      message: reason ? `Cancelled: ${reason}` : 'Cancelled by the user.',
      failureReason: reason,
    });

    if (!applied) {
      throw new ConflictException('The task changed state before the cancellation was applied.');
    }

    await this.orchestrator.cancel(taskId);

    await this.audit.record({
      event: AUDIT_EVENTS.TASK_CANCELLED,
      projectId: task.projectId,
      userId: user.userId,
      metadata: { taskReference: task.reference, reason },
    });

    return { id: taskId, status: 'cancelled' as const };
  }

  /**
   * The project's conversations, newest first (ADR-047).
   *
   * This is what the workspace's history pane lists. Each row carries enough to
   * be read without opening it — how many requests it holds, when it was last
   * worked on, and the state of its most recent task — because the alternative
   * is a list of titles that all look alike.
   *
   * The counts are computed in one grouped query rather than per row: a project
   * with fifty sessions would otherwise be fifty round trips to render a
   * sidebar.
   */
  async listSessions(user: AuthenticatedUser, projectId: string) {
    await this.authz.requireProjectAccess(user, projectId);

    const sessions = await this.database.db
      .select({
        id: agentSessions.id,
        title: agentSessions.title,
        status: agentSessions.status,
        startedAt: agentSessions.startedAt,
        endedAt: agentSessions.endedAt,
      })
      .from(agentSessions)
      .where(eq(agentSessions.projectId, projectId))
      .orderBy(desc(agentSessions.startedAt))
      .limit(50);

    if (sessions.length === 0) return [];

    const sessionIds = sessions.map((session) => session.id);

    const counts = await this.database.db
      .select({
        sessionId: agentTasks.sessionId,
        taskCount: sqlCount(),
        lastActivityAt: sqlMaxCreatedAt(),
      })
      .from(agentTasks)
      .where(inArray(agentTasks.sessionId, sessionIds))
      .groupBy(agentTasks.sessionId);

    const countBySession = new Map(counts.map((row) => [row.sessionId, row]));

    // The most recent task of each session, for the status dot. Fetched as one
    // ordered read over the same ids and reduced here, because "first row per
    // group" is awkward to express portably and this list is bounded at 50
    // sessions.
    const recent = await this.database.db
      .select({
        sessionId: agentTasks.sessionId,
        status: agentTasks.status,
        prompt: agentTasks.prompt,
        createdAt: agentTasks.createdAt,
      })
      .from(agentTasks)
      .where(inArray(agentTasks.sessionId, sessionIds))
      .orderBy(desc(agentTasks.createdAt));

    const latestBySession = new Map<string, (typeof recent)[number]>();
    for (const row of recent) {
      if (row.sessionId && !latestBySession.has(row.sessionId)) {
        latestBySession.set(row.sessionId, row);
      }
    }

    return sessions.map((session) => {
      const aggregate = countBySession.get(session.id);
      const latest = latestBySession.get(session.id);
      return {
        ...session,
        taskCount: Number(aggregate?.taskCount ?? 0),
        lastActivityAt: aggregate?.lastActivityAt ?? session.startedAt,
        latestStatus: latest?.status ?? null,
        // Falls back to the first prompt the session was named with, so a
        // session always shows something a person can recognise.
        latestPrompt: latest?.prompt ?? session.title,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async openSession(
    projectId: string,
    userId: string,
    firstPrompt: string,
  ): Promise<string> {
    const [session] = await this.database.db
      .insert(agentSessions)
      .values({
        projectId,
        userId,
        status: 'active',
        // The first prompt names the session, so task history is readable
        // without opening each task.
        title: firstPrompt.split(/\r?\n/)[0].slice(0, 120),
      })
      .returning({ id: agentSessions.id });

    return session.id;
  }

  private async assertSessionBelongsToProject(
    sessionId: string,
    projectId: string,
  ): Promise<string> {
    const [session] = await this.database.db
      .select({ id: agentSessions.id })
      .from(agentSessions)
      .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.projectId, projectId)))
      .limit(1);

    if (!session) {
      throw new BadRequestException('That session does not belong to this project.');
    }
    return session.id;
  }

  /**
   * Inserts the task, retrying on a reference collision. References are
   * generated rather than sequential, so a collision is possible but rare; the
   * unique index is the authority.
   */
  /**
   * Confirms every attached document id belongs to this project (ADR-030), and
   * returns them in the order given. A mistyped id fails the request instead of
   * silently running without the document.
   */
  private async resolveAttachedDocuments(
    projectId: string,
    documentIds: string[],
  ): Promise<string[]> {
    if (documentIds.length === 0) return [];

    const rows = await this.database.db
      .select({ id: projectDocuments.id })
      .from(projectDocuments)
      .where(
        and(
          eq(projectDocuments.projectId, projectId),
          inArray(projectDocuments.id, documentIds),
        ),
      );

    const found = new Set(rows.map((row) => row.id));
    const missing = documentIds.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new BadRequestException(
        `Attached document not found on this project: ${missing.join(', ')}`,
      );
    }

    return documentIds;
  }

  private async insertTask(values: {
    projectId: string;
    sessionId: string;
    createdByUserId: string;
    prompt: string;
    kind: AgentTaskKind;
    environmentId: string;
    attachedDocumentIds: string[];
  }) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const [task] = await this.database.db
          .insert(agentTasks)
          .values({
            ...values,
            reference: this.taskRepository.candidateReference(),
            status: 'created',
            // Phase 2 clones, edits and commits for real, so the task is not
            // wholly simulated; the categories that still are get named instead
            // (ADR-019).
            simulated: this.registry.simulatedCapabilities().length ===
              this.registry.all().length,
            simulatedCapabilities: [...this.registry.simulatedCapabilities()],
          })
          .returning({
            id: agentTasks.id,
            reference: agentTasks.reference,
            status: agentTasks.status,
          });
        return task;
      } catch (error) {
        if (!isUniqueViolation(error) || attempt === 4) throw error;
      }
    }
    throw new ConflictException('Could not allocate a task reference. Please try again.');
  }
}

/** PostgreSQL unique-violation SQLSTATE. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';
}
