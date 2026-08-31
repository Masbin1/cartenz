import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Worker, type Job } from 'bullmq';
import { loadDefaultDotEnv } from './core/config/dotenv';
import { AppModule } from './app.module';
import { APP_CONFIG } from './core/config/config.module';
import type { AppConfig } from './core/config/configuration';
import { RedisService } from './core/redis/redis.service';
import { AgentWorkflow } from './agent/orchestration/agent-workflow';
import { AGENT_TASK_QUEUE } from './core/redis/redis.constants';
import type { AgentJobData } from './agent/orchestration/queue-agent-orchestrator';

/**
 * Agent worker entry point.
 *
 * The same application module as the API, without the HTTP listener: the worker
 * needs the database, Redis, the tool layer and the workflow, and sharing the
 * module graph is what guarantees it enforces the same permission and audit
 * logic (ADR-016).
 *
 * The job handler is deliberately thin. It resolves the task and hands it to the
 * workflow, which decides what to do from the task's own status. A job therefore
 * carries no state, and a retry re-enters the workflow at whatever point the task
 * has actually reached.
 */
async function bootstrap(): Promise<void> {
  loadDefaultDotEnv();

  const logger = new Logger('Worker');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  /**
   * Nest's shutdown hooks are deliberately NOT enabled here.
   *
   * They install their own signal listeners, which close the Redis connections
   * as part of closing the application. The BullMQ worker holds one of those
   * connections open on a blocking read, so if Nest closes first, the worker's
   * own close never completes and the process hangs until it is killed.
   *
   * The order below is the whole reason for handling the signals directly:
   * drain the worker, then close the application.
   */
  const config = app.get<AppConfig>(APP_CONFIG);
  const redis = app.get(RedisService);
  const workflow = app.get(AgentWorkflow);

  const worker = new Worker<AgentJobData>(
    AGENT_TASK_QUEUE,
    async (job: Job<AgentJobData>) => {
      logger.log(`Processing ${job.name} for task ${job.data.taskId}`);
      await workflow.run(job.data.taskId);
    },
    {
      connection: redis.queueConnection,
      concurrency: config.agent.workerConcurrency,
    },
  );

  worker.on('failed', (job, error) => {
    logger.error(`Job ${job?.id ?? 'unknown'} failed: ${error.message}`);
  });

  worker.on('completed', (job) => {
    logger.log(`Job ${job.id} completed`);
  });

  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    // A second signal during shutdown must not start a second shutdown.
    if (shuttingDown) return;
    shuttingDown = true;

    logger.log(`Received ${signal}; draining the worker`);

    /**
     * A backstop. `worker.close()` waits for an in-flight job, which is correct:
     * abandoning a task mid-step is worse than a slow exit. But a job that hangs
     * must not hold the process open indefinitely, so the exit is forced after a
     * bounded wait. 25 seconds sits inside the 35-second grace period used by
     * dev-down.sh and the 30 seconds used by Compose.
     */
    const forceExit = setTimeout(() => {
      logger.error('Shutdown did not complete in 25s; exiting.');
      process.exit(1);
    }, 25_000);
    forceExit.unref();

    try {
      // The worker closes first, releasing the blocking read on the queue
      // connection, so that closing the application can then close it cleanly.
      await worker.close();
      await app.close();
    } catch (error) {
      logger.error(`Error during shutdown: ${(error as Error).message}`);
    }

    clearTimeout(forceExit);
    logger.log('Worker stopped');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  logger.log(
    `Agent worker listening on queue "${AGENT_TASK_QUEUE}" with concurrency ${config.agent.workerConcurrency}`,
  );
}

bootstrap().catch((error: unknown) => {
  process.stderr.write(`Failed to start the worker: ${(error as Error).message}\n`);
  process.exit(1);
});
