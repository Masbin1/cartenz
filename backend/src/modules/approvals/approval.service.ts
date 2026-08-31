import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { DatabaseService } from '../../core/database/database.service';
import { agentTasks, approvals, projects } from '../../core/database/schema';
import { AuditService } from '../../core/audit/audit.service';
import { AUDIT_EVENTS } from '../../core/audit/audit-events';
import { TaskEventPublisher } from '../../core/events/task-event-publisher.service';
import { AuthorizationService } from '../../core/authz/authorization.service';
import { redactMetadata } from '../../core/audit/redact';
import type { AuthenticatedUser } from '../../core/authz/authenticated-user';
import type { AgentTaskStatus } from '../../agent/task-state';
import {
  AGENT_ORCHESTRATOR,
  type AgentOrchestrator,
} from '../../agent/orchestration/agent-orchestrator.interface';

export interface RequestApprovalInput {
  readonly taskId: string;
  readonly taskReference: string;
  readonly organizationId: string;
  readonly action: string;
  readonly requiredReason: string;
  readonly context: Record<string, unknown>;
  readonly taskStatus: AgentTaskStatus;
}

/** Approval actions that concern a production system. */
const PRODUCTION_ACTIONS: readonly string[] = [
  'deployment',
  'database_migration',
  'service_restart',
];

/**
 * The approval system (chapter 11).
 *
 * Approval records are persistent and are the authority on whether a restricted
 * action may proceed: the permission validator reads granted approvals from this
 * table, so an approval is not a message passed between processes but a fact in
 * the database. A worker that restarts mid-task therefore sees the same
 * approvals it saw before.
 *
 * Requesting an approval is idempotent per task and action. A step that runs
 * twice - after a retry, say - does not produce two pending requests for the
 * same thing.
 */
@Injectable()
export class ApprovalService {
  private readonly logger = new Logger(ApprovalService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly events: TaskEventPublisher,
    private readonly audit: AuditService,
    private readonly authz: AuthorizationService,
    @Inject(forwardRef(() => AGENT_ORCHESTRATOR))
    private readonly orchestrator: AgentOrchestrator,
  ) {}

  async request(input: RequestApprovalInput): Promise<void> {
    const [existing] = await this.database.db
      .select({ id: approvals.id, status: approvals.status })
      .from(approvals)
      .where(
        and(
          eq(approvals.taskId, input.taskId),
          eq(approvals.action, input.action as never),
          eq(approvals.status, 'pending'),
        ),
      )
      .limit(1);

    if (existing) {
      this.logger.log(
        `Approval for ${input.action} on ${input.taskReference} is already pending; not re-requesting.`,
      );
      return;
    }

    await this.database.db.insert(approvals).values({
      organizationId: input.organizationId,
      taskId: input.taskId,
      action: input.action as never,
      status: 'pending',
      requiredReason: input.requiredReason,
      context: redactMetadata(input.context),
    });

    await this.events.publish({
      taskId: input.taskId,
      taskReference: input.taskReference,
      type: 'approval_required',
      status: 'pending',
      taskStatus: input.taskStatus,
      message: input.requiredReason,
      payload: { action: input.action, context: input.context },
    });

    await this.audit.record({
      event: AUDIT_EVENTS.APPROVAL_REQUESTED,
      organizationId: input.organizationId,
      metadata: {
        taskReference: input.taskReference,
        action: input.action,
        reason: input.requiredReason,
      },
    });
  }

  /** Pending approvals across an organisation, for the dashboard. */
  async listPending(user: AuthenticatedUser, organizationId: string) {
    await this.authz.requireOrganizationMember(user, organizationId);

    return this.database.db
      .select({
        id: approvals.id,
        taskId: approvals.taskId,
        taskReference: agentTasks.reference,
        projectId: agentTasks.projectId,
        projectName: projects.name,
        action: approvals.action,
        requiredReason: approvals.requiredReason,
        context: approvals.context,
        requestedAt: approvals.requestedAt,
      })
      .from(approvals)
      .innerJoin(agentTasks, eq(agentTasks.id, approvals.taskId))
      .innerJoin(projects, eq(projects.id, agentTasks.projectId))
      .where(and(eq(approvals.organizationId, organizationId), eq(approvals.status, 'pending')))
      .orderBy(desc(approvals.requestedAt));
  }

  async listForTask(user: AuthenticatedUser, taskId: string) {
    const task = await this.loadTask(taskId);
    await this.authz.requireProjectAccess(user, task.projectId);

    return this.database.db
      .select()
      .from(approvals)
      .where(eq(approvals.taskId, taskId))
      .orderBy(desc(approvals.requestedAt));
  }

  /**
   * Records a decision and resumes or fails the task.
   *
   * The decision is written first and the resumption is requested afterwards. If
   * the resumption fails, the decision still stands and the task can be resumed
   * again; the reverse order would risk a task resuming on a decision that was
   * never recorded.
   */
  async decide(
    user: AuthenticatedUser,
    taskId: string,
    decision: 'approved' | 'rejected',
    note: string | undefined,
  ) {
    const task = await this.loadTask(taskId);
    const context = await this.authz.requireProjectAccess(user, task.projectId, 'developer');

    const [pending] = await this.database.db
      .select()
      .from(approvals)
      .where(and(eq(approvals.taskId, taskId), eq(approvals.status, 'pending')))
      .orderBy(desc(approvals.requestedAt))
      .limit(1);

    if (!pending) {
      throw new BadRequestException('This task has no approval awaiting a decision.');
    }

    this.authz.requireApprovalAuthority(
      context.membership,
      PRODUCTION_ACTIONS.includes(pending.action),
    );

    const decided = await this.database.db
      .update(approvals)
      .set({
        status: decision,
        decidedAt: new Date(),
        decidedByUserId: user.userId,
        decisionNote: note ?? null,
      })
      .where(and(eq(approvals.id, pending.id), eq(approvals.status, 'pending')))
      .returning({ id: approvals.id });

    if (decided.length === 0) {
      // Another approver decided it between the read and the write.
      throw new BadRequestException('This approval has already been decided.');
    }

    await this.audit.record({
      event: decision === 'approved' ? AUDIT_EVENTS.APPROVAL_GRANTED : AUDIT_EVENTS.APPROVAL_REJECTED,
      organizationId: context.organizationId,
      projectId: task.projectId,
      userId: user.userId,
      metadata: { taskReference: task.reference, action: pending.action, note },
    });

    await this.events.publish({
      taskId,
      taskReference: task.reference,
      type: 'agent_activity',
      status: decision === 'approved' ? 'running' : 'failed',
      taskStatus: task.status,
      message:
        decision === 'approved'
          ? `${pending.action.replace(/_/g, ' ')} approved by ${user.name}.`
          : `${pending.action.replace(/_/g, ' ')} rejected by ${user.name}.`,
      payload: { action: pending.action, decision, note },
    });

    await this.orchestrator.resume(
      taskId,
      decision === 'approved' ? 'approval_granted' : 'approval_rejected',
    );

    return { id: pending.id, action: pending.action, status: decision };
  }

  private async loadTask(taskId: string) {
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
    return { ...task, status: task.status as AgentTaskStatus };
  }
}
