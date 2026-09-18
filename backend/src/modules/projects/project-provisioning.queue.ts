import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { Queue } from 'bullmq';
import { RedisService } from '../../core/redis/redis.service';
import {
  PROJECT_PROVISIONING_JOB,
  PROJECT_PROVISIONING_QUEUE,
} from '../../core/redis/redis.constants';
import type { OdooEdition, UserRegion } from '../../core/enums';

/**
 * ADR-056 job payload. Identifiers only, matching the agent queue's convention
 * (`AgentJobData`): the worker re-reads what it needs, so a job carries no
 * state and survives a Redis flush.
 */
export interface SelectiveProvisionJobData {
  readonly projectId: string;
  readonly technicalName: string;
  readonly odooEdition: OdooEdition;
  readonly odooVersion: string | null;
  readonly region: UserRegion;
  readonly modules: readonly string[];
  /**
   * The port allocated when the job was queued. Carried in the payload rather
   * than re-allocated by the worker: `provision` records this same port on the
   * pending row before returning, and the worker's completion update must
   * write the port the row already claims. Two independent allocations could
   * pick different ports, leaving the row pointing at one while the instance
   * listens on another.
   */
  readonly port: number;
}

/**
 * Owns the BullMQ queue a selective module install is handed to (ADR-056).
 *
 * A separate class rather than a `Queue` field on `ProjectProvisioningService`
 * for two reasons. It matches the shape already established by
 * `QueueAgentOrchestrator` for the agent queue, so there is one way this
 * codebase talks to BullMQ. And it keeps the queue's Redis connection out of
 * `ProjectProvisioningService`'s constructor: that service is unit-tested with
 * a hand-built harness, and a real connection opened in its constructor makes
 * Jest hang on exit rather than reporting a result. Depending on an injectable
 * wrapper lets the spec pass a stub.
 *
 * Why a dedicated queue instead of a job name on `AGENT_TASK_QUEUE`: this work
 * has nothing to do with agent task execution, shares no payload shape with it,
 * and the agent worker's concurrency setting must not throttle project
 * provisioning (or vice versa).
 */
@Injectable()
export class ProjectProvisioningQueue implements OnApplicationShutdown {
  private readonly logger = new Logger(ProjectProvisioningQueue.name);
  private readonly queue: Queue<SelectiveProvisionJobData>;

  constructor(redis: RedisService) {
    this.queue = new Queue<SelectiveProvisionJobData>(PROJECT_PROVISIONING_QUEUE, {
      connection: redis.queueConnection,
      defaultJobOptions: {
        /**
         * One attempt, deliberately. Re-running the create script against a
         * project directory that now exists fails outright rather than
         * retrying cleanly (the scripts refuse an existing path — the same
         * property ADR-039 relies on). A failure is written onto the project
         * row for an operator to read, not retried behind their back.
         */
        attempts: 1,
        removeOnComplete: { age: 3600, count: 500 },
        removeOnFail: { age: 86_400, count: 500 },
      },
    });
  }

  /**
   * Queues a selective install. The job id is derived from the project's
   * technical name, so an accidental double enqueue is de-duplicated by BullMQ
   * rather than provisioning the same project twice — the same reasoning as
   * `QueueAgentOrchestrator`'s derived job ids.
   */
  async enqueue(data: SelectiveProvisionJobData): Promise<void> {
    await this.queue.add(PROJECT_PROVISIONING_JOB, data, {
      jobId: `provision-${data.technicalName}`,
    });
    this.logger.log(
      `Queued selective provisioning for "${data.technicalName}" (${data.modules.length} module(s))`,
    );
  }

  async onApplicationShutdown(): Promise<void> {
    await this.queue.close();
  }
}
