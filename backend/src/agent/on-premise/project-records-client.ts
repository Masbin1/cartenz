import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { APP_CONFIG } from '../../core/config/config.module';
import type { AppConfig } from '../../core/config/configuration';
import { DatabaseService } from '../../core/database/database.service';
import { projects } from '../../core/database/schema';
import { CommandRunner } from '../../core/process/command-runner.service';
import { technicalNameFromOnPremisePath } from '../../modules/projects/project-deployment.service';

/**
 * The on-premise record read/write path (ADR-075): the executor the three
 * record tools call for `on_premise`, standing beside `OdooOnlineClient`'s
 * JSON-RPC path for `odoo_online`. Same validated request shape, same
 * four-plus-one operations, different transport - a root-run
 * `odoo-bin shell` through `CommandRunner` instead of HTTP.
 *
 * Mirrors ProjectDbSetupService's own shape (stdin request, sudo through the
 * same two gates, a JSON report line picked out of the log). Never throws for
 * a refused or failed operation: the caller decides what a tool error looks
 * like, this class only runs the script and parses what it printed.
 */
export interface RecordsSearchRequest {
  readonly operation: 'search';
  readonly model: string;
  readonly domain?: unknown[];
  readonly fields?: readonly string[];
  readonly limit?: number;
  readonly offset?: number;
}

export interface RecordsCountRequest {
  readonly operation: 'count';
  readonly model: string;
  readonly domain?: unknown[];
}

export interface RecordsAggregateRequest {
  readonly operation: 'aggregate';
  readonly model: string;
  readonly domain?: unknown[];
  readonly fields: readonly string[];
  readonly groupBy: readonly string[];
  readonly limit?: number;
}

export interface RecordsCreateRequest {
  readonly operation: 'create';
  readonly model: string;
  readonly records: readonly Record<string, unknown>[];
}

export interface RecordsWriteRequest {
  readonly operation: 'write';
  readonly model: string;
  readonly ids: readonly number[];
  readonly values: Record<string, unknown>;
}

export type RecordsRequest =
  | RecordsSearchRequest
  | RecordsCountRequest
  | RecordsAggregateRequest
  | RecordsCreateRequest
  | RecordsWriteRequest;

export class ProjectRecordsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectRecordsError';
  }
}

/** Generous: a 2000-row search against a cold cache should still finish. */
const RECORDS_TIMEOUT_MS = 2 * 60 * 1000;

@Injectable()
export class ProjectRecordsClient {
  private readonly logger = new Logger(ProjectRecordsClient.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly commands: CommandRunner,
    private readonly database: DatabaseService,
  ) {}

  /** True when this deployment has the script and its sudo grant. */
  get available(): boolean {
    return Boolean(this.config.provisioning?.enabled && this.config.provisioning.recordsScript);
  }

  /**
   * Resolves a project's on-premise technical name - the same derivation
   * every other root-run script uses (backup, teardown, restart) - from its
   * stored `environmentConfig.onPremisePath`, anchored to the configured
   * projects roots so a row cannot point this at an arbitrary directory.
   */
  async resolveTechnicalName(projectId: string): Promise<string | null> {
    const [project] = await this.database.db
      .select({ environmentConfig: projects.environmentConfig })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    if (!project) return null;
    return technicalNameFromOnPremisePath(project.environmentConfig, [
      this.config.provisioning?.projectsDir ?? '',
      this.config.provisioning?.projectsDir20 ?? '',
    ]);
  }

  /** Runs one request against a project's own database. Throws on refusal or failure. */
  async run(technicalName: string, request: RecordsRequest): Promise<unknown> {
    if (!this.available) {
      throw new ProjectRecordsError(
        'On-premise record access is not enabled on this deployment ' +
          '(PROJECT_RECORDS_SCRIPT is empty, or PROJECT_PROVISIONING_ENABLED is false).',
      );
    }

    const script = this.config.provisioning!.recordsScript!;
    let result;
    try {
      result = await this.commands.run('sudo', ['-n', script, technicalName], {
        cwd: '/',
        stdin: JSON.stringify(request),
        timeoutMs: RECORDS_TIMEOUT_MS,
      });
    } catch (error) {
      const message = (error as Error).message;
      this.logger.error(`Record ${request.operation} on "${technicalName}" failed to start: ${message}`);
      throw new ProjectRecordsError(message);
    }

    const report = parseRecordsReport(result.stdout);
    if (result.exitCode !== 0 || result.timedOut) {
      const tail = (result.stderr || '').trim().split('\n').slice(-5).join('\n');
      const message = result.timedOut
        ? 'The record operation timed out.'
        : report?.detail || tail || `the records script exited with code ${result.exitCode}.`;
      this.logger.error(`Record ${request.operation} on "${technicalName}" failed: ${message}`);
      throw new ProjectRecordsError(message);
    }

    if (!report) {
      throw new ProjectRecordsError('The records script produced no report.');
    }
    if (report.status !== 'ok') {
      throw new ProjectRecordsError(report.detail || 'The record operation was refused.');
    }
    return report.result;
  }
}

interface RecordsReport {
  readonly status: 'ok' | 'failed';
  readonly result: unknown;
  readonly detail: string;
}

/**
 * The one report line project-records.sh already stripped the
 * "RECORDS_REPORT: " prefix from. Mirrors parseSetupReport's own
 * tolerance - anything that is not exactly this shape is treated as absent
 * rather than thrown on, so a stray log line cannot crash the caller.
 */
export function parseRecordsReport(stdout: string): RecordsReport | null {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<RecordsReport>;
      if (parsed.status === 'ok' || parsed.status === 'failed') {
        return {
          status: parsed.status,
          result: parsed.result ?? null,
          detail: String(parsed.detail ?? ''),
        };
      }
    } catch {
      // not a report line
    }
  }
  return null;
}
