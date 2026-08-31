import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { DatabaseService } from '../../core/database/database.service';
import {
  agentActions,
  agentSessions,
  agentTaskEvents,
  agentTasks,
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
import { REPOSITORY_BACKED_PROJECT_TYPES, type ProjectType } from '../../core/enums';
import type { AuthenticatedUser } from '../../core/authz/authenticated-user';
import type { CreateTaskDto } from './dto/task.dto';

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

  async create(user: AuthenticatedUser, projectId: string, dto: CreateTaskDto) {
    const context = await this.authz.requireProjectAccess(user, projectId, 'developer');

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
     * A project with no repository cannot be worked on at all.
     *
     * Checked here rather than discovered by the workflow, because the alternative
     * is worse than it sounds: the task would clone nothing, plan anyway, ask a
     * person to approve that plan, and only then fail because there is nothing to
     * modify. Refusing at submission tells the user the one thing they need to do.
     *
     * This applies to every project type, including ai_project. The AI creation
     * flow produces a specification; changing code still requires a repository.
     */
    if (!project.repositoryUrl) {
      const guidance = REPOSITORY_BACKED_PROJECT_TYPES.includes(
        project.projectType as ProjectType,
      )
        ? 'Connect one in the project settings before submitting a task.'
        : 'This project was created from a specification and has no repository yet. Connect one before submitting a development request.';

      throw new BadRequestException(`This project has no repository connected. ${guidance}`);
    }

    if (context.agentPermissions.repository_read !== true) {
      throw new BadRequestException(
        'The agent is not permitted to read this project. Enable repository read in the project settings.',
      );
    }

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

    const sessionId = dto.sessionId
      ? await this.assertSessionBelongsToProject(dto.sessionId, projectId)
      : await this.openSession(projectId, user.userId, dto.prompt);

    const task = await this.insertTask({
      organizationId: context.organizationId,
      projectId,
      sessionId,
      createdByUserId: user.userId,
      prompt: dto.prompt,
      environmentId: environment.id,
    });

    await this.audit.record({
      event: AUDIT_EVENTS.TASK_CREATED,
      organizationId: context.organizationId,
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

  async listForProject(user: AuthenticatedUser, projectId: string, limit = 50) {
    await this.authz.requireProjectAccess(user, projectId);

    return this.database.db
      .select({
        id: agentTasks.id,
        reference: agentTasks.reference,
        prompt: agentTasks.prompt,
        status: agentTasks.status,
        branch: agentTasks.branch,
        commitHash: agentTasks.commitHash,
        simulated: agentTasks.simulated,
        createdAt: agentTasks.createdAt,
        startedAt: agentTasks.startedAt,
        completedAt: agentTasks.completedAt,
      })
      .from(agentTasks)
      .where(eq(agentTasks.projectId, projectId))
      .orderBy(desc(agentTasks.createdAt))
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
      status: task.status,
      branch: task.branch,
      commitHash: task.commitHash,
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

    const context = await this.authz.requireProjectAccess(user, task.projectId, 'developer');
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
      organizationId: context.organizationId,
      projectId: task.projectId,
      userId: user.userId,
      metadata: { taskReference: task.reference, reason },
    });

    return { id: taskId, status: 'cancelled' as const };
  }

  async listSessions(user: AuthenticatedUser, projectId: string) {
    await this.authz.requireProjectAccess(user, projectId);

    return this.database.db
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
  private async insertTask(values: {
    organizationId: string;
    projectId: string;
    sessionId: string;
    createdByUserId: string;
    prompt: string;
    environmentId: string;
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
