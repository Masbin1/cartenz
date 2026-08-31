import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { Queue } from 'bullmq';
import { RedisService } from '../../core/redis/redis.service';
import {
  AGENT_JOB_EXECUTE,
  AGENT_JOB_RESUME,
  AGENT_TASK_QUEUE,
} from '../../core/redis/redis.constants';
import { APP_CONFIG } from '../../core/config/config.module';
import type { AppConfig } from '../../core/config/configuration';
import type { AgentOrchestrator, ResumeReason } from './agent-orchestrator.interface';

/**
 * BullMQ rejects a custom job id containing a colon, so the separator is a
 * hyphen. Built in one place rather than spelled out at each call site: start
 * and cancel must agree or cancellation silently fails to find the job.
 */
function executeJobId(taskId: string): string {
  return `execute-${taskId}`;
}

/** Payload of an agent task job. Kept to identifiers only. */
export interface AgentJobData {
  readonly taskId: string;
  readonly reason?: ResumeReason;
}

/**
 * BullMQ implementation of the orchestration contract (ADR-011).
 *
 * The job payload carries nothing but the task identifier. Everything the
 * workflow needs it reads from the database, which is what allows a Temporal
 * implementation to replace this one without a payload migration - and what
 * keeps task state out of Redis, where it would not survive a flush.
 *
 * Job identifiers are derived from the task, so an accidental double enqueue is
 * de-duplicated by BullMQ rather than running the workflow twice.
 */
@Injectable()
export class QueueAgentOrchestrator implements AgentOrchestrator, OnApplicationShutdown {
  private readonly logger = new Logger(QueueAgentOrchestrator.name);
  private readonly queue: Queue<AgentJobData>;

  constructor(
    redis: RedisService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.queue = new Queue<AgentJobData>(AGENT_TASK_QUEUE, {
      connection: redis.queueConnection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        // Completed and failed jobs are pruned: the durable record of what
        // happened is agent_actions, not the queue.
        removeOnComplete: { age: 3600, count: 500 },
        removeOnFail: { age: 86_400, count: 500 },
      },
    });

    void config;
  }

  async start(taskId: string): Promise<void> {
    await this.queue.add(
      AGENT_JOB_EXECUTE,
      { taskId },
      { jobId: executeJobId(taskId) },
    );
    this.logger.log(`Queued task ${taskId} for execution`);
  }

  async resume(taskId: string, reason: ResumeReason): Promise<void> {
    await this.queue.add(
      AGENT_JOB_RESUME,
      { taskId, reason },
      // The job id includes the reason and a monotonic suffix so that a second
      // approval on the same task is not de-duplicated against the first.
      { jobId: `resume-${taskId}-${reason}-${Date.now()}` },
    );
    this.logger.log(`Queued task ${taskId} for resumption (${reason})`);
  }

  async cancel(taskId: string): Promise<void> {
    /**
     * Cancellation is cooperative. The status is already written by the caller;
     * removing a job that has not started spares a pointless wake-up, and a job
     * already running observes the status at its next step boundary.
     */
    const job = await this.queue.getJob(executeJobId(taskId));
    if (job && (await job.isWaiting())) {
      await job.remove();
      this.logger.log(`Removed queued job for cancelled task ${taskId}`);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.queue.close();
  }
}
