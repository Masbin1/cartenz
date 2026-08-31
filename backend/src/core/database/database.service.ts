import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/configuration';
import * as schema from './schema';
import {
  buildReport,
  describeReport,
  ISOLATION_QUERY,
  type IsolationReport,
} from './database-isolation';

export type Database = NodePgDatabase<typeof schema>;

/**
 * The database a connection string points at.
 *
 * Falls back to an empty name rather than throwing: a URL this cannot parse is
 * a problem the pool will report far more clearly than a helper would, and the
 * isolation report is not worth failing a boot over.
 */
function readDatabaseName(url: string): string {
  try {
    return new URL(url).pathname.replace(/^[/]/, '');
  } catch {
    return '';
  }
}

/**
 * Owns the PostgreSQL pool and the Drizzle client. The only place a connection
 * is created, so pool sizing, TLS and shutdown are decided once.
 */
@Injectable()
export class DatabaseService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseService.name);
  private readonly pool: Pool;
  private readonly databaseName: string;
  private isolation: IsolationReport | null = null;
  readonly db: Database;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    // Parsed from the URL rather than configured separately, so the two cannot
    // disagree about which database is the platform's own.
    this.databaseName = readDatabaseName(config.database.url);

    this.pool = new Pool({
      connectionString: config.database.url,
      max: config.database.poolMax,
      ssl: config.database.ssl ? { rejectUnauthorized: false } : undefined,
      // Fail a stalled connection attempt rather than hanging a request.
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
    });

    // An idle client error would otherwise reach the process as an unhandled
    // rejection and take the API down.
    this.pool.on('error', (error) => {
      this.logger.error(`Idle PostgreSQL client error: ${error.message}`);
    });

    this.db = drizzle(this.pool, { schema });
  }

  /** Liveness probe for the health endpoint. Cheap and does not touch a table. */
  async ping(): Promise<boolean> {
    try {
      await this.db.execute(sql`select 1`);
      return true;
    } catch (error) {
      this.logger.error(`PostgreSQL ping failed: ${(error as Error).message}`);
      return false;
    }
  }

  /**
   * Runs work inside a transaction. Exposed so that call sites do not reach for
   * the pool directly when they need atomicity.
   */
  transaction<T>(work: (tx: Parameters<Parameters<Database['transaction']>[0]>[0]) => Promise<T>) {
    return this.db.transaction(work);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
    this.logger.log('PostgreSQL pool closed');
  }

  /**
   * Reports which other databases the platform's credentials can open (ADR-026).
   *
   * Run once at startup. Failure to determine it is logged and ignored: a
   * permission problem reading `pg_database` must not stop the platform booting,
   * and the check is a report rather than a control.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const result = await this.pool.query<{ datname: string }>(ISOLATION_QUERY);
      const report = buildReport(this.databaseName, result.rows);
      this.isolation = report;

      for (const line of describeReport(report)) {
        if (report.isolated) this.logger.log(line);
        else this.logger.warn(line);
      }
    } catch (error) {
      this.logger.warn(
        `Could not determine database isolation: ${(error as Error).message}`,
      );
    }
  }

  /** The last isolation report, for the health endpoint. Null until bootstrap. */
  get isolationReport(): IsolationReport | null {
    return this.isolation;
  }
}
