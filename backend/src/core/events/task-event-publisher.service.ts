import { Injectable, Logger } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { RedisService } from '../redis/redis.service';
import { agentTaskEvents } from '../database/schema';
import { taskEventChannel } from '../redis/redis.constants';
import { redactMetadata } from '../audit/redact';
import type { TaskEvent, TaskEventStatus, TaskEventType } from './event-types';
import type { AgentTaskStatus } from '../../agent/task-state';

export interface PublishTaskEventInput {
  readonly taskId: string;
  readonly taskReference: string;
  readonly type: TaskEventType;
  readonly status: TaskEventStatus;
  readonly taskStatus: AgentTaskStatus;
  readonly message: string;
  readonly payload?: Record<string, unknown>;
}

/**
 * Persists and publishes task events.
 *
 * Persist-then-publish, in that order and deliberately. A client that connects
 * mid-task, or reconnects after a dropped socket, replays the table and then
 * follows the live stream; if publication came first, an event could be
 * delivered to a live client and be missing from the replay of the client that
 * reconnected a moment later.
 *
 * The sequence number is allocated from the table rather than from process
 * state, so it stays correct across worker restarts and with several workers
 * running.
 */
@Injectable()
export class TaskEventPublisher {
  private readonly logger = new Logger(TaskEventPublisher.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly redis: RedisService,
  ) {}

  async publish(input: PublishTaskEventInput): Promise<TaskEvent> {
    const payload = input.payload ? redactMetadata(input.payload) : undefined;

    const [row] = await this.database.db
      .insert(agentTaskEvents)
      .values({
        taskId: input.taskId,
        sequence: sql`(
          select coalesce(max(e.sequence), 0) + 1
          from agent_task_events e
          where e.task_id = ${input.taskId}
        )`,
        eventType: input.type,
        status: input.status,
        message: input.message,
        payload: payload ?? null,
      })
      .returning({ sequence: agentTaskEvents.sequence, createdAt: agentTaskEvents.createdAt });

    const event: TaskEvent = {
      taskId: input.taskId,
      taskReference: input.taskReference,
      sequence: row.sequence,
      type: input.type,
      status: input.status,
      taskStatus: input.taskStatus,
      message: input.message,
      at: row.createdAt.toISOString(),
      payload,
    };

    try {
      await this.redis.publish(taskEventChannel(input.taskId), event);
    } catch (error) {
      // The event is already durable. A publication failure costs liveness for
      // connected clients, not correctness, and must not fail the task.
      this.logger.warn(
        `Failed to publish event ${input.type} for task ${input.taskReference}: ${(error as Error).message}`,
      );
    }

    return event;
  }

  /** Replays a task's event history, oldest first, for a client that connects late. */
  async history(taskId: string, limit = 500) {
    return this.database.db
      .select()
      .from(agentTaskEvents)
      .where(eq(agentTaskEvents.taskId, taskId))
      .orderBy(agentTaskEvents.sequence)
      .limit(limit);
  }
}
