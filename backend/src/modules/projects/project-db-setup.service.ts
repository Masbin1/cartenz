import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { APP_CONFIG } from '../../core/config/config.module';
import type { AppConfig } from '../../core/config/configuration';
import { DatabaseService } from '../../core/database/database.service';
import { projects } from '../../core/database/schema';
import { CommandRunner } from '../../core/process/command-runner.service';
import type { ConfigurationItem } from '../settings/odoo-setup-plan';

/** One plan entry's outcome, as the applier reported it (ADR-073). */
export interface DbSetupReportItem {
  readonly item: number;
  readonly kind: string;
  readonly label: string;
  readonly status: 'applied' | 'skipped' | 'failed';
  readonly detail: string;
}

/** Matches the `db_setup_status` column enum exactly (ADR-073 §5). */
export type DbSetupStatus = 'none' | 'pending' | 'applied' | 'partial' | 'failed';

export interface DbSetupOutcome {
  readonly status: DbSetupStatus;
  readonly report: readonly DbSetupReportItem[];
  readonly error: string | null;
}

/** What the applier is handed on stdin. Only the configuration list travels. */
export interface DbSetupPlan {
  readonly configuration: readonly ConfigurationItem[];
}

/** Generous: installing a language loads its translations for every module. */
const DB_SETUP_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Applies a reviewed fit-gap configuration plan to a provisioned project's
 * database (ADR-073), through the root-run `apply-db-setup.sh` under the same
 * two gates as every other privileged script: the sudoers `Cmnd_Alias` and
 * `assertProvisioningInvocation`. The plan travels on stdin, never in argv.
 *
 * Never throws for an applier failure: setup is a step after a project is
 * already usable, so its outcome is recorded on the project (`none` means
 * "nothing to do" and is not a failure), never raised to the provisioning job.
 */
@Injectable()
export class ProjectDbSetupService {
  private readonly logger = new Logger(ProjectDbSetupService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly commands: CommandRunner,
    private readonly database: DatabaseService,
  ) {}

  /** True when this deployment has the applier and its sudo grant. */
  get available(): boolean {
    return Boolean(this.config.provisioning?.enabled && this.config.provisioning.dbSetupScript);
  }

  /**
   * Runs the stored plan for one project and records the outcome on it.
   * A project with no plan (or an empty one) is left at `none`.
   */
  async applyStoredPlan(projectId: string, technicalName: string): Promise<DbSetupOutcome> {
    const [project] = await this.database.db
      .select({ plan: projects.dbSetupPlan })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    // The column holds the accepted configuration list itself (an array), the
    // same shape `selectedModules` holds module names in.
    const configuration = (project?.plan ?? []) as unknown as ConfigurationItem[];
    if (!Array.isArray(configuration) || configuration.length === 0) {
      return this.record(projectId, { status: 'none', report: [], error: null });
    }
    const plan: DbSetupPlan = { configuration };

    if (!this.available) {
      return this.record(projectId, {
        status: 'failed',
        report: [],
        error:
          'Database setup is not enabled on this deployment (PROJECT_DB_SETUP_SCRIPT is empty, ' +
          'or PROJECT_PROVISIONING_ENABLED is false).',
      });
    }

    await this.database.db
      .update(projects)
      .set({ dbSetupStatus: 'pending', dbSetupError: null, updatedAt: new Date() })
      .where(eq(projects.id, projectId));

    return this.record(projectId, await this.run(technicalName, plan));
  }

  private async run(technicalName: string, plan: DbSetupPlan): Promise<DbSetupOutcome> {
    const script = this.config.provisioning!.dbSetupScript!;
    let result;
    try {
      result = await this.commands.run('sudo', ['-n', script, technicalName], {
        cwd: '/',
        stdin: JSON.stringify({ configuration: plan.configuration }),
        timeoutMs: DB_SETUP_TIMEOUT_MS,
      });
    } catch (error) {
      const message = (error as Error).message;
      this.logger.error(`Database setup of "${technicalName}" failed to start: ${message}`);
      return { status: 'failed', report: [], error: message };
    }

    const report = parseSetupReport(result.stdout);
    if (result.exitCode !== 0 || result.timedOut) {
      const tail = (result.stderr || '').trim().split('\n').slice(-5).join('\n');
      const message = result.timedOut
        ? 'The setup step timed out.'
        : tail || `The setup script exited with code ${result.exitCode}.`;
      this.logger.error(`Database setup of "${technicalName}" failed: ${message}`);
      return { status: report.length > 0 ? 'partial' : 'failed', report, error: message };
    }

    return { status: summarise(report), report, error: null };
  }

  private async record(projectId: string, outcome: DbSetupOutcome): Promise<DbSetupOutcome> {
    await this.database.db
      .update(projects)
      .set({
        dbSetupStatus: outcome.status,
        dbSetupReport: outcome.report as unknown as Record<string, unknown>[],
        dbSetupError: outcome.error,
        dbSetupAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(projects.id, projectId));
    return outcome;
  }
}

/**
 * Applier report lines. apply-db-setup.sh has already stripped the
 * "DB_SETUP_REPORT: " prefix, so each is one JSON object; anything else on
 * stdout is skipped rather than trusted.
 */
export function parseSetupReport(stdout: string): DbSetupReportItem[] {
  const items: DbSetupReportItem[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<DbSetupReportItem>;
      if (
        typeof parsed.item === 'number' &&
        (parsed.status === 'applied' || parsed.status === 'skipped' || parsed.status === 'failed')
      ) {
        items.push({
          item: parsed.item,
          kind: String(parsed.kind ?? ''),
          label: String(parsed.label ?? ''),
          status: parsed.status,
          detail: String(parsed.detail ?? ''),
        });
      }
    } catch {
      // not a report line
    }
  }
  return items;
}

/** All applied/skipped is `applied`; any failure beside a success is `partial`. */
export function summarise(report: readonly DbSetupReportItem[]): DbSetupStatus {
  if (report.length === 0) return 'failed';
  const failed = report.filter((r) => r.status === 'failed').length;
  if (failed === 0) return 'applied';
  return failed === report.length ? 'failed' : 'partial';
}
