import { Inject, Injectable, Logger } from '@nestjs/common';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from 'pg';
import { APP_CONFIG } from '../../core/config/config.module';
import type { AppConfig } from '../../core/config/configuration';
import { CommandRunner } from '../../core/process/command-runner.service';
import { buildOdooConf, buildTestArguments } from './odoo-conf';
import {
  parseRuntimes,
  selectRuntime,
  UnknownOdooRuntimeError,
  type OdooRuntime,
} from './odoo-runtime-registry';
import {
  assertScratchDatabase,
  scratchDatabaseName,
  ScratchDatabaseError,
} from './scratch-database';
import { parseTestOutput, summariseRun } from './odoo-test-output';

export interface ValidationRequest {
  readonly taskReference: string;
  readonly attempt: number;
  /** The task's clone. Never the live addons directory. */
  readonly repositoryPath: string;
  /** Where the generated conf goes: beside the clone, not inside it. */
  readonly metadataPath: string;
  readonly odooVersion: string | null;
  /** The modules to install and test. */
  readonly modules: readonly string[];
}

export interface ValidationOutcome {
  readonly ran: boolean;
  /** Why not, when it did not. Shown to the person reviewing the task. */
  readonly skippedReason: string | null;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly results: ReturnType<typeof summariseRun> | null;
  readonly fatal: string | null;
  readonly runtime: string | null;
}

/**
 * Runs a project's own Odoo modules and reports what happened (ADR-027).
 *
 * The order of operations is the design. The scratch database is created, the
 * conf is written beside the clone rather than inside it, the run is bounded by a
 * timeout, and the database is dropped in a `finally` — so a crash, a timeout or
 * a thrown error all leave the same thing behind, which is nothing.
 *
 * Everything this class does is refused unless VALIDATION_ENABLED is true, and
 * that is enforced below it, at the process chokepoint, rather than here: a check
 * in this class would be one someone could route around by calling something else.
 */
@Injectable()
export class OdooValidationRunner {
  private readonly logger = new Logger(OdooValidationRunner.name);
  private readonly runtimes: OdooRuntime[];

  constructor(
    private readonly commands: CommandRunner,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.runtimes = this.readRuntimes();
  }

  /** True when this deployment could validate at all. */
  get available(): boolean {
    return this.config.validation.enabled && this.runtimes.length > 0;
  }

  async run(request: ValidationRequest): Promise<ValidationOutcome> {
    const startedAt = Date.now();

    const unavailable = this.reasonUnavailable(request);
    if (unavailable) {
      return {
        ran: false,
        skippedReason: unavailable,
        exitCode: null,
        durationMs: 0,
        results: null,
        fatal: null,
        runtime: null,
      };
    }

    let runtime: OdooRuntime;
    try {
      runtime = selectRuntime(this.runtimes, request.odooVersion);
    } catch (error) {
      if (error instanceof UnknownOdooRuntimeError) {
        return {
          ran: false,
          skippedReason: error.message,
          exitCode: null,
          durationMs: 0,
          results: null,
          fatal: null,
          runtime: null,
        };
      }
      throw error;
    }

    const database = scratchDatabaseName(request.taskReference, request.attempt);
    const confDirectory = join(request.metadataPath, 'validation');
    const confPath = join(confDirectory, 'odoo.conf');

    await mkdir(confDirectory, { recursive: true });
    await writeFile(
      confPath,
      buildOdooConf({
        coreAddonsPath: join(runtime.corePath, 'addons'),
        sharedAddonPaths: runtime.sharedAddonPaths,
        workspaceAddonsPath: request.repositoryPath,
        databaseName: database,
        databaseHost: this.config.validation.databaseHost,
        databasePort: this.config.validation.databasePort,
        databaseUser: this.config.validation.databaseUser,
      }),
      // Readable only by the platform's user: it names the validation role and
      // the host, and there is no reason for another user to read it.
      { mode: 0o600 },
    );

    try {
      await this.createDatabase(database);

      const result = await this.commands.run(
        'python3',
        [join(runtime.corePath, 'odoo-bin'), ...buildTestArguments({
          confPath,
          databaseName: database,
          modules: request.modules,
        })],
        {
          cwd: runtime.corePath,
          timeoutMs: this.config.validation.timeoutMs,
          // The password reaches the process here rather than through the conf,
          // so it does not sit in a file that outlives the run.
          env: { PGPASSWORD: this.config.validation.databasePassword },
        },
      );

      const log = `${result.stdout}\n${result.stderr}`;
      const parsed = parseTestOutput(log);

      this.logger.log(
        `Validation for ${request.taskReference} on Odoo ${runtime.series}: exit ${result.exitCode}, ` +
          `${parsed.modules.length} module(s), ${parsed.failures.length} failure(s)`,
      );

      return {
        ran: true,
        skippedReason: null,
        exitCode: result.exitCode,
        durationMs: Date.now() - startedAt,
        results: summariseRun(parsed, result.exitCode),
        fatal: parsed.fatal,
        runtime: `odoo ${runtime.series}`,
      };
    } finally {
      // In a finally, so a timeout, a crash and a thrown error all leave the same
      // thing behind. A scratch database left on a customer's cluster is exactly
      // the kind of litter that turns into a question about what else was left.
      await this.dropDatabase(database);
      await rm(confDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Why validation cannot run, phrased for the person reading the task. */
  private reasonUnavailable(request: ValidationRequest): string | null {
    if (!this.config.validation.enabled) {
      return (
        'Validation is disabled on this server (VALIDATION_ENABLED=false), so the ' +
        'change was not run. The diff is on the task for review.'
      );
    }

    if (this.runtimes.length === 0) {
      return (
        'Validation is enabled but no Odoo runtime is configured, so there is nothing ' +
        'to run the change against. Set ODOO_RUNTIMES.'
      );
    }

    if (!this.config.validation.databaseUser || !this.config.validation.databasePassword) {
      return (
        'Validation is enabled but no validation database role is configured. Set ' +
        'VALIDATION_DB_USER and VALIDATION_DB_PASSWORD to a role with CREATEDB and ' +
        'nothing else - never the Odoo role, which owns the customer databases.'
      );
    }

    if (request.modules.length === 0) {
      return 'The change touched no Odoo module, so there was nothing to install and test.';
    }

    return null;
  }

  /**
   * Its own connection, as the validation role, to the maintenance database.
   *
   * Not the platform's pool: that authenticates as the platform's role, which
   * cannot create databases and should not be able to. Creating the database as
   * the role that will own it is also what makes the drop possible without
   * privileges this platform should not hold.
   */
  private async withMaintenanceClient<T>(work: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({
      host: this.config.validation.databaseHost,
      port: this.config.validation.databasePort,
      user: this.config.validation.databaseUser,
      password: this.config.validation.databasePassword,
      database: 'postgres',
      connectionTimeoutMillis: 10_000,
    });

    await client.connect();
    try {
      return await work(client);
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  private async createDatabase(name: string): Promise<void> {
    assertScratchDatabase(name, 'create');

    await this.withMaintenanceClient(async (client) => {
      const existing = await client.query('select 1 from pg_database where datname = $1', [name]);

      // Refused rather than reused. A name that already exists means either a
      // previous run was not cleaned up or the name is not what this thinks it
      // is, and installing modules into a database of unknown provenance is not
      // something to do quietly.
      if (existing.rowCount && existing.rowCount > 0) {
        throw new ScratchDatabaseError(
          `The validation database "${name}" already exists. A previous run did not clean ` +
            'up. Drop it and try again.',
        );
      }

      // Identifier interpolation, because a database name cannot be a bind
      // parameter in CREATE DATABASE. Safe because the name was generated by
      // scratchDatabaseName and re-checked above; nothing from a caller reaches
      // here.
      await client.query(`create database "${name}"`);
    });
  }

  private async dropDatabase(name: string): Promise<void> {
    try {
      assertScratchDatabase(name, 'drop');

      await this.withMaintenanceClient(async (client) => {
        // Odoo leaves connections behind on a killed run, and DROP DATABASE fails
        // while any remain.
        await client.query(
          'select pg_terminate_backend(pid) from pg_stat_activity where datname = $1',
          [name],
        );
        await client.query(`drop database if exists "${name}"`);
      });
    } catch (error) {
      // Logged, never thrown: a failure to clean up must not mask the test result
      // the person is waiting for. The name is included so it can be dropped by
      // hand.
      this.logger.error(
        `Could not drop the validation database "${name}": ${(error as Error).message}`,
      );
    }
  }

  private readRuntimes(): OdooRuntime[] {
    if (!this.config.validation.runtimes) return [];

    try {
      return parseRuntimes(
        this.config.validation.runtimes,
        this.config.validation.sharedAddonPaths,
      );
    } catch (error) {
      // A malformed ODOO_RUNTIMES must not stop the platform booting: validation
      // is one capability, and the rest of the platform works without it.
      this.logger.error(`ODOO_RUNTIMES is not usable: ${(error as Error).message}`);
      return [];
    }
  }
}
