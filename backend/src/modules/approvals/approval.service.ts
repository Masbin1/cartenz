import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
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
  readonly action: string;
  readonly requiredReason: string;
  readonly context: Record<string, unknown>;
  readonly taskStatus: AgentTaskStatus;
}

/**
 * An approval the deployment itself grants, recorded as one.
 *
 * A task whose push this deployment performs automatically (ADR-041) still has to
 * satisfy the tool gate that guards every operation leaving the platform: the
 * gate reads granted approvals from this table. Until this existed the two
 * disagreed - the workflow decided no approval was needed and moved the task to
 * `pushing`, and the gate, seeing no `git_push` row, refused the very push the
 * workflow had just authorised. The refusal was recorded, the suspension that
 * followed was illegal from `pushing`, the job died, and BullMQ retried it. Every
 * retry asked for the approval again, which is why an operator saw the same
 * `git_push` prompt two and three times for one push.
 */
export interface AutoGrantInput {
  readonly taskId: string;
  readonly taskReference: string;
  readonly action: string;
  readonly requiredReason: string;
  readonly context: Record<string, unknown>;
  readonly taskStatus: AgentTaskStatus;
  /** What authorised it, named in the record. */
  readonly authorisedBy: string;
}

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
    /**
     * Asked once, and only once, for a given action on a given task.
     *
     * This used to dedupe against a *pending* row alone, which is not the
     * property that matters. A granted approval is still a live authorisation -
     * the permission validator reads every approved row for the task - so asking
     * again after one was granted is asking a person to authorise what they have
     * already authorised. It happened because a step that ran twice (a retry
     * after a failed job) re-requested the push, and the second, third and fourth
     * prompts were for one push that had been approved at the first.
     *
     * A rejection is deliberately not deduped: a rejected task must be able to
     * ask again, and the row that stands is the newer decision.
     */
    const [existing] = await this.database.db
      .select({ id: approvals.id, status: approvals.status })
      .from(approvals)
      .where(
        and(
          eq(approvals.taskId, input.taskId),
          eq(approvals.action, input.action as never),
          inArray(approvals.status, ['pending', 'approved']),
        ),
      )
      .limit(1);

    if (existing) {
      this.logger.log(
        `Approval for ${input.action} on ${input.taskReference} is already ` +
          `${existing.status}; not re-requesting.`,
      );
      return;
    }

    await this.database.db.insert(approvals).values({
      taskId: input.taskId,
      action: input.action as never,
      status: 'pending',
      requiredReason: input.requiredReason,
      context: redactMetadata(input.context),
    }).onConflictDoNothing();

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
      metadata: {
        taskReference: input.taskReference,
        action: input.action,
        reason: input.requiredReason,
      },
    });
  }

  /**
   * Records a deployment-granted approval as already approved, so that a task
   * suspended at this gate resumes on the next loop rather than waiting for a
   * person to confirm what the deployment already authorised.
   *
   * Written as a normal approval row rather than as a bypass, because the row is
   * what every reader consults: the permission validator, the workflow's
   * `grantedApprovals`, the approval list shown next to the task, and the audit
   * trail answering "who authorised this push". A bypass that only the validator
   * knew about would satisfy the gate while leaving the record saying nobody did.
   *
   * Idempotent: an already-decided row for the action is left alone, so a step
   * that runs twice (a retry) does not create a second grant or disturb a newer
   * human decision on the same action.
   */
  async autoGrant(input: AutoGrantInput): Promise<void> {
    const [existing] = await this.database.db
      .select({ id: approvals.id, status: approvals.status })
      .from(approvals)
      .where(
        and(
          eq(approvals.taskId, input.taskId),
          eq(approvals.action, input.action as never),
          inArray(approvals.status, ['pending', 'approved']),
        ),
      )
      .limit(1);

    if (existing) {
      this.logger.log(
        `Approval for ${input.action} on ${input.taskReference} already ${existing.status}; ` +
          'the deployment did not grant it again.',
      );
      return;
    }

    const now = new Date();
    await this.database.db.insert(approvals).values({
      taskId: input.taskId,
      action: input.action as never,
      status: 'approved',
      requiredReason: input.requiredReason,
      context: redactMetadata(input.context),
      requestedAt: now,
      decidedAt: now,
    }).onConflictDoNothing();

    await this.events.publish({
      taskId: input.taskId,
      taskReference: input.taskReference,
      type: 'agent_activity',
      status: 'running',
      taskStatus: input.taskStatus,
      message: `${input.action.replace(/_/g, ' ')} was authorised by ${input.authorisedBy}.`,
      payload: { action: input.action, context: input.context },
    });

    await this.audit.record({
      event: AUDIT_EVENTS.APPROVAL_GRANTED,
      metadata: {
        taskReference: input.taskReference,
        action: input.action,
        reason: input.authorisedBy,
        automatic: true,
      },
    });
  }

  /**
   * Pending approvals across every project, for the dashboard.
   *
   * Was scoped to one organisation. With one flat space there is nothing to
   * scope it to, so it returns everything — which is also the right answer for
   * an approvals queue: a pending decision nobody can see is a task stalled.
   */
  async listPending(user: AuthenticatedUser) {
    await this.authz.requireApprovalAuthority(user);

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
      .where(eq(approvals.status, 'pending'))
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
    await this.authz.requireProjectAccess(user, task.projectId);

    const [pending] = await this.database.db
      .select()
      .from(approvals)
      .where(and(eq(approvals.taskId, taskId), eq(approvals.status, 'pending')))
      .orderBy(desc(approvals.requestedAt))
      .limit(1);

    if (!pending) {
      throw new BadRequestException('This task has no approval awaiting a decision.');
    }

    this.authz.requireApprovalAuthority(user);

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
      pending.id,
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
