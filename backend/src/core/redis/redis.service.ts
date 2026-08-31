import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/configuration';

/**
 * Owns the Redis connections.
 *
 * Three connections are held deliberately. A connection in subscriber mode
 * cannot issue ordinary commands, so publishing and subscribing require separate
 * clients; BullMQ additionally requires a connection with
 * maxRetriesPerRequest set to null, which is unsuitable for ordinary use.
 */
@Injectable()
export class RedisService implements OnApplicationShutdown {
  private readonly logger = new Logger(RedisService.name);

  /** General-purpose commands and publishing. */
  readonly client: Redis;
  /** Subscriber-mode connection, used only by the realtime gateway. */
  readonly subscriber: Redis;
  /** Connection handed to BullMQ queues and workers. */
  readonly queueConnection: Redis;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.client = new Redis(config.redis.url, { lazyConnect: false });
    this.subscriber = new Redis(config.redis.url, { lazyConnect: false });
    this.queueConnection = new Redis(config.redis.url, {
      // Required by BullMQ: a blocking command must not be abandoned.
      maxRetriesPerRequest: null,
    });

    for (const [name, connection] of [
      ['client', this.client],
      ['subscriber', this.subscriber],
      ['queue', this.queueConnection],
    ] as const) {
      connection.on('error', (error: Error) => {
        this.logger.error(`Redis ${name} connection error: ${error.message}`);
      });
    }
  }

  /** Liveness probe for the health endpoint. */
  async ping(): Promise<boolean> {
    try {
      const reply = await this.client.ping();
      return reply === 'PONG';
    } catch (error) {
      this.logger.error(`Redis ping failed: ${(error as Error).message}`);
      return false;
    }
  }

  async publish(channel: string, payload: unknown): Promise<void> {
    await this.client.publish(channel, JSON.stringify(payload));
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([
      this.client.quit(),
      this.subscriber.quit(),
      this.queueConnection.quit(),
    ]);
    this.logger.log('Redis connections closed');
  }
}
