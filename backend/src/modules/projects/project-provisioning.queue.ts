import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { Queue } from 'bullmq';
import { RedisService } from '../../core/redis/redis.service';
import {
  PROJECT_PROVISIONING_JOB,
  PROJECT_PROVISIONING_QUEUE,
  PROJECT_RESTART_JOB,
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
 * ADR-057 job payload for restarting a project's instance: pulling the branch
 * named, upgrading every installed module (`-u all`), and bouncing the unit.
 * Identifiers only, matching `SelectiveProvisionJobData`'s convention.
 */
export interface ProjectRestartJobData {
  readonly projectId: string;
  readonly technicalName: string;
  readonly repositoryUrl: string;
  readonly branch: string;
  readonly userId: string;
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
  // A separate typed Queue instance pointed at the same underlying BullMQ
  // queue name (see the constant's own comment for why it is the same queue):
  // BullMQ's TypeScript generics are per-instance, and typing every `.add()`
  // call for a queue that carries two different payload shapes needs two
  // instances even though there is only one queue in Redis.
  private readonly restartQueue: Queue<ProjectRestartJobData>;

  constructor(redis: RedisService) {
    /**
     * One attempt, deliberately. Re-running the create script against a
     * project directory that now exists fails outright rather than retrying
     * cleanly (the scripts refuse an existing path — the same property
     * ADR-039 relies on). A failure is written onto the project row for an
     * operator to read, not retried behind their back. A restart shares this
     * policy for the same shape of reason: a failed `-u all` has already been
     * rolled back by the script, and repeating it would only repeat the
     * failure.
     */
    const defaultJobOptions = {
      attempts: 1,
      removeOnComplete: { age: 3600, count: 500 },
      removeOnFail: { age: 86_400, count: 500 },
    } as const;

    this.queue = new Queue<SelectiveProvisionJobData>(PROJECT_PROVISIONING_QUEUE, {
      connection: redis.queueConnection,
      defaultJobOptions,
    });
    this.restartQueue = new Queue<ProjectRestartJobData>(PROJECT_PROVISIONING_QUEUE, {
      connection: redis.queueConnection,
      defaultJobOptions,
    });
  }

  /**
   * Queues a selective install. The job id is derived from the project's
   * technical name, so an accidental double enqueue is de-duplicated by BullMQ
   * rather than provisioning the same project twice — the same reasoning as
   * `QueueAgentOrchestrator`'s derived job ids.
   */
  async enqueue(data: SelectiveProvisionJobData): Promise<void> {
    const jobId = `provision-${data.technicalName}`;

    // See enqueueRestart's comment on the same shape of check: a finished job
    // occupying this id is not re-run by add(), it is handed back unchanged,
    // so a retry after a failed provisioning attempt would otherwise be a
    // silent no-op for up to an hour.
    const existing = await this.queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === 'completed' || state === 'failed') {
        await existing.remove();
      }
    }

    await this.queue.add(PROJECT_PROVISIONING_JOB, data, { jobId });
    this.logger.log(
      `Queued selective provisioning for "${data.technicalName}" (${data.modules.length} module(s))`,
    );
  }

  /**
   * Queues a restart. The job id is derived from the project's technical name
   * the same way a provisioning job's is — a second restart request while one
   * is already running is de-duplicated by BullMQ rather than racing two
   * `-u all` runs against the same database.
   */
  async enqueueRestart(data: ProjectRestartJobData): Promise<void> {
    const jobId = `restart-${data.technicalName}`;

    /**
     * A *finished* job with this id has to be cleared first, and this is not an
     * optimisation — it is the difference between a retry working and silently
     * doing nothing.
     *
     * BullMQ answers `add()` with the existing job when the id is taken and does
     * not re-queue it. Our jobs are `removeOnComplete: { age: 3600 }`, so for an
     * hour after a restart the id belongs to a row in the completed set. Every
     * retry inside that window was handed back the old job, the worker was never
     * called, and the project row sat on `restartStatus: 'pending'` with nothing
     * running — a button that looked stuck rather than a failure that could be
     * read. The first restart attempt failing made every later attempt a no-op.
     *
     * Only the terminal states are removed. `active`/`waiting` keeps its id, so
     * the de-duplication this id exists for still holds: two simultaneous
     * restarts of one project cannot both run.
     */
    const existing = await this.restartQueue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === 'completed' || state === 'failed') {
        await existing.remove();
      }
    }

    await this.restartQueue.add(PROJECT_RESTART_JOB, data, { jobId });
    this.logger.log(`Queued restart for "${data.technicalName}" (${data.branch})`);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.queue.close();
    await this.restartQueue.close();
  }
}
