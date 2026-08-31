import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { DatabaseService } from '../../core/database/database.service';
import { RedisService } from '../../core/redis/redis.service';
import { Public } from '../../core/http/public.decorator';
import { APP_CONFIG } from '../../core/config/config.module';
import type { AppConfig } from '../../core/config/configuration';

/**
 * Health endpoints.
 *
 * Two are exposed because they answer different questions. /health says the
 * process is up and is what a load balancer polls; /health/ready says the
 * dependencies are reachable and is what an orchestrator uses before sending
 * traffic. Conflating them would take a replica out of service for a transient
 * database blip.
 */
@Controller('health')
export class HealthController {
  private readonly startedAt = Date.now();

  constructor(
    private readonly database: DatabaseService,
    private readonly redis: RedisService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @Get()
  liveness() {
    return {
      status: 'ok',
      service: 'linkederp-api',
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }

  @Public()
  @Get('ready')
  async readiness(@Res() response: Response) {
    const [database, redis] = await Promise.all([this.database.ping(), this.redis.ping()]);
    const ready = database && redis;

    // 503 rather than 200-with-a-flag: an orchestrator reads the status code.
    response.status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE).json({
      status: ready ? 'ready' : 'not_ready',
      checks: {
        postgres: database ? 'up' : 'down',
        redis: redis ? 'up' : 'down',
      },
    });
  }

  /**
   * Security posture of this deployment, as facts rather than assurances.
   *
   * Public, like the other health endpoints, and deliberately so: it says what
   * this server cannot do, and nothing about what it holds. Someone deciding
   * whether to connect a repository should not need an account to find out
   * whether the platform can push, and an operator should not need to read the
   * logs to find out whether its credentials reach a customer's database.
   */
  @Public()
  @Get('posture')
  posture() {
    const isolation = this.database.isolationReport;

    return {
      git: {
        pushEnabled: this.config.git.pushEnabled,
        // Named for the setting so the answer and the lever have the same name.
        setting: 'GIT_PUSH_ENABLED',
      },
      database: isolation
        ? {
            ownDatabase: isolation.ownDatabase,
            isolated: isolation.isolated,
            // Counted, not named: this endpoint is public, and the names of a
            // customer's databases are not the platform's to publish.
            otherDatabasesReachable: isolation.reachable.length,
          }
        : { checked: false },
      dataBoundary: {
        // Not configurable, and stated because that is the point.
        appliesToEveryModelCall: true,
      },
    };
  }
}
