import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DatabaseService } from '../../core/database/database.service';
import { agentActions } from '../../core/database/schema';
import { redactMetadata } from '../../core/audit/redact';
import { AuditService } from '../../core/audit/audit.service';
import { AUDIT_EVENTS } from '../../core/audit/audit-events';
import { TaskEventPublisher } from '../../core/events/task-event-publisher.service';
import { ToolPermissionValidator, type ToolPolicyContext } from './permission-validator';
import type { ToolExecutionContext, ToolExecutionResult } from './tool.interface';
import type { AgentTaskStatus } from '../task-state';

export interface ExecuteToolInput {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly context: ToolExecutionContext;
  readonly policy: ToolPolicyContext;
  readonly taskStatus: AgentTaskStatus;
}

/** Raised when a tool cannot run until an approval is granted. */
export class ApprovalRequiredError extends Error {
  constructor(
    readonly toolName: string,
    readonly approvalAction: string,
    readonly reason: string,
  ) {
    super(reason);
    this.name = 'ApprovalRequiredError';
  }
}

/**
 * The only path from an agent's intent to an effect.
 *
 * The sequence is fixed and is the security property described in chapter 19:
 * validate, record that the attempt began, execute, record the outcome, publish.
 * A denial is recorded and published exactly as an execution is, because a
 * refused request is the more interesting audit event of the two.
 *
 * The persisted copy of tool output passes through the audit redaction filter,
 * which also truncates long strings. The copy returned to the caller does not:
 * see the note in execute. Output is redacted before it is persisted or
 * published, so a tool that inadvertently returned a credential could not put it
 * in the database or send it to a browser.
 */
@Injectable()
export class ToolExecutionService {
  private readonly logger = new Logger(ToolExecutionService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly validator: ToolPermissionValidator,
    private readonly events: TaskEventPublisher,
    private readonly audit: AuditService,
  ) {}

  async execute(request: ExecuteToolInput): Promise<ToolExecutionResult> {
    const decision = this.validator.validate(
      { toolName: request.toolName, input: request.input },
      request.policy,
    );

    if (decision.outcome === 'denied') {
      return this.recordDenial(request, decision.reason);
    }

    if (decision.outcome === 'approval_required') {
      // Not a failure: the task suspends and resumes once a person decides.
      await this.recordDenial(request, decision.reason, 'approval_required');
      throw new ApprovalRequiredError(request.toolName, decision.approvalAction, decision.reason);
    }

    const tool = decision.tool;

    await this.events.publish({
      taskId: request.context.taskId,
      taskReference: request.context.taskReference,
      type: 'tool_started',
      status: 'running',
      taskStatus: request.taskStatus,
      message: tool.description,
      payload: { toolName: tool.name, simulated: tool.simulated },
    });

    const startedAt = Date.now();
    try {
      const output = await tool.execute(request.input, request.context);
      const durationMs = Date.now() - startedAt;

      // Two different copies, for two different purposes, and conflating them was
      // a real defect (ADR-022). redactMetadata truncates every string to 2 KB,
      // which is right for an audit row and an event payload and wrong for the
      // value the agent acts on: it made read_file silently return the first ~55
      // lines of any larger file, so a write-back destroyed the rest. Every test
      // fixture was under 2 KB, so nothing caught it until a real repository did.
      //
      // The caller gets the tool's actual output. What protects a model from
      // seeing something it should not is the AI data boundary, which is a
      // separate chokepoint and is not weakened by this.
      const redacted = redactMetadata(output);

      await this.appendAction({
        taskId: request.context.taskId,
        actionType: 'tool',
        toolName: tool.name,
        input: request.input,
        output: redacted,
        status: 'succeeded',
        simulated: tool.simulated,
        durationMs,
      });

      await this.events.publish({
        taskId: request.context.taskId,
        taskReference: request.context.taskReference,
        type: 'tool_completed',
        status: 'succeeded',
        taskStatus: request.taskStatus,
        message: `${tool.name} completed`,
        payload: { toolName: tool.name, durationMs, simulated: tool.simulated, result: redacted },
      });

      await this.audit.record({
        event: AUDIT_EVENTS.AGENT_ACTION_COMPLETED,
        organizationId: request.context.organizationId,
        projectId: request.context.projectId,
        metadata: { taskReference: request.context.taskReference, toolName: tool.name, durationMs },
      });

      return {
        toolName: tool.name,
        status: 'succeeded',
        output,
        durationMs,
        simulated: tool.simulated,
      };
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const message = (error as Error).message;

      this.logger.warn(`Tool ${tool.name} failed for ${request.context.taskReference}: ${message}`);

      await this.appendAction({
        taskId: request.context.taskId,
        actionType: 'tool',
        toolName: tool.name,
        input: request.input,
        output: { error: message },
        status: 'failed',
        simulated: tool.simulated,
        durationMs,
      });

      await this.events.publish({
        taskId: request.context.taskId,
        taskReference: request.context.taskReference,
        type: 'tool_completed',
        status: 'failed',
        taskStatus: request.taskStatus,
        message: `${tool.name} failed`,
        payload: { toolName: tool.name, error: message },
      });

      return {
        toolName: tool.name,
        status: 'failed',
        output: { error: message },
        durationMs,
        simulated: tool.simulated,
      };
    }
  }

  /**
   * Records a refused request. Reason: an unexecuted tool call is evidence about
   * what the agent tried to do, which is exactly what an audit trail is for.
   */
  private async recordDenial(
    request: ExecuteToolInput,
    reason: string,
    kind: 'denied' | 'approval_required' = 'denied',
  ): Promise<ToolExecutionResult> {
    await this.appendAction({
      taskId: request.context.taskId,
      actionType: 'tool',
      toolName: request.toolName,
      input: request.input,
      output: null,
      status: 'denied',
      denialReason: reason,
      simulated: false,
      durationMs: 0,
    });

    await this.events.publish({
      taskId: request.context.taskId,
      taskReference: request.context.taskReference,
      type: 'tool_completed',
      status: 'failed',
      taskStatus: request.taskStatus,
      message:
        kind === 'approval_required'
          ? `${request.toolName} is awaiting approval`
          : `${request.toolName} was refused`,
      payload: { toolName: request.toolName, reason, kind },
    });

    await this.audit.record({
      event: AUDIT_EVENTS.AGENT_ACTION_DENIED,
      organizationId: request.context.organizationId,
      projectId: request.context.projectId,
      metadata: {
        taskReference: request.context.taskReference,
        toolName: request.toolName,
        reason,
        kind,
      },
    });

    return {
      toolName: request.toolName,
      status: 'denied',
      output: null,
      denialReason: reason,
      durationMs: 0,
      simulated: false,
    };
  }

  /**
   * Appends to the agent action log. The sequence is allocated by the database
   * so that it remains correct with several workers running, and the row is
   * never updated afterwards.
   */
  async appendAction(entry: {
    taskId: string;
    actionType: 'reasoning' | 'tool' | 'transition' | 'approval';
    toolName?: string | null;
    input?: Record<string, unknown> | null;
    output?: Record<string, unknown> | null;
    status: 'running' | 'succeeded' | 'failed' | 'denied';
    denialReason?: string | null;
    simulated?: boolean;
    durationMs?: number | null;
  }): Promise<void> {
    await this.database.db.insert(agentActions).values({
      taskId: entry.taskId,
      sequence: sql`(
        select coalesce(max(a.sequence), 0) + 1
        from agent_actions a
        where a.task_id = ${entry.taskId}
      )`,
      actionType: entry.actionType,
      toolName: entry.toolName ?? null,
      input: entry.input ? redactMetadata(entry.input) : null,
      output: entry.output ? redactMetadata(entry.output) : null,
      status: entry.status,
      denialReason: entry.denialReason ?? null,
      simulated: entry.simulated ?? false,
      durationMs: entry.durationMs ?? null,
    });
  }
}
