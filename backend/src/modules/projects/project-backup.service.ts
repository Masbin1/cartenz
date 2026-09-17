import { Inject, Injectable, Logger } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { APP_CONFIG } from '../../core/config/config.module';
import type { AppConfig } from '../../core/config/configuration';
import { DatabaseService } from '../../core/database/database.service';
import { projectBackups, projects } from '../../core/database/schema';
import { AuditService } from '../../core/audit/audit.service';
import { AUDIT_EVENTS } from '../../core/audit/audit-events';
import { CommandRunner } from '../../core/process/command-runner.service';
import type { BackupReason, BackupStatus } from '../../core/enums';
import type { AuthenticatedUser } from '../../core/authz/authenticated-user';
import { AuthorizationService } from '../../core/authz/authorization.service';
import { technicalNameFromOnPremisePath } from './project-deployment.service';

/** What the portal renders about one backup. */
export interface BackupSummary {
  readonly id: string;
  readonly status: BackupStatus;
  readonly reason: BackupReason;
  readonly backupId: string | null;
  readonly path: string | null;
  readonly sizeBytes: number | null;
  readonly error: string | null;
  readonly taskId: string | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

/**
 * The result of asking for a backup.
 *
 * `skipped` is a fact about the project or the deployment, not a failure of the
 * thing that asked: a project with no provisioned instance has nothing to back
 * up, and a deployment without the script cannot take one. A pre-push hook must
 * tell those apart from `failed`, because only `failed` blocks a push.
 */
export type BackupOutcome =
  | { readonly kind: 'taken'; readonly backup: BackupSummary }
  | { readonly kind: 'failed'; readonly message: string; readonly backup: BackupSummary | null }
  | { readonly kind: 'skipped'; readonly message: string };

export interface BackupAvailability {
  readonly available: boolean;
  /** Shown when not available, so the portal can explain instead of hiding. */
  readonly reason: string | null;
}

/**
 * Per-client backups (ADR-054).
 *
 * A backup is the project's database, filestore and addons repository, taken by
 * a root-run script (`infrastructure/provisioning/backup-project.sh`) under
 * `/opt/odoo/backups` - readable and restorable by an operator with no access
 * to this platform, which is the point: a backup only this system can restore
 * is not a backup.
 *
 * The script runs as root for the same reason every provisioning step does:
 * the project directory is `odoo:odoo` mode 750 and the database belongs to the
 * `odoo` role, neither of which this process can read. It is invoked through
 * the same two gates as the other root-run scripts (the sudoers `Cmnd_Alias`
 * and `assertProvisioningInvocation`), with the narrow shape
 * `-n <script> <project-name>`.
 *
 * Used two ways: a person asking from the portal, and the workflow's pre-push
 * hook - before a push onto a staging (or main-named) branch, so a promotion
 * always has an immediately preceding restore point.
 */
@Injectable()
export class ProjectBackupService {
  private readonly logger = new Logger(ProjectBackupService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly commands: CommandRunner,
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly authz: AuthorizationService,
  ) {}

  /** True when this deployment has the backup script and its sudo grant. */
  get available(): boolean {
    return Boolean(this.config.provisioning?.enabled && this.config.provisioning.backupScript);
  }

  /** Whether the portal should offer the action, and why not when it should not. */
  availability(): BackupAvailability {
    if (this.available) return { available: true, reason: null };
    return {
      available: false,
      reason:
        'Backup is not enabled on this deployment (PROJECT_BACKUP_SCRIPT is empty, or ' +
        'PROJECT_PROVISIONING_ENABLED is false).',
    };
  }

  /**
   * Takes a backup of one project's instance.
   *
   * `taskId` records the task whose push it was taken for, when it was
   * automatic; `userId` is the person who asked, when a person did.
   */
  async run(
    projectId: string,
    options: {
      readonly reason: BackupReason;
      readonly taskId?: string | null;
      readonly userId?: string | null;
    },
  ): Promise<BackupOutcome> {
    if (!this.available) {
      return { kind: 'skipped', message: this.availability().reason ?? 'Backup is not enabled.' };
    }

    const [project] = await this.database.db
      .select({
        id: projects.id,
        name: projects.name,
        environmentConfig: projects.environmentConfig,
        provisioningStatus: projects.provisioningStatus,
      })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    if (!project) {
      return { kind: 'skipped', message: 'Project not found.' };
    }

    // Anchored to the configured projects root, exactly as the pull resolves
    // it; never derived from the path's own shape.
    const technicalName = technicalNameFromOnPremisePath(
      project.environmentConfig,
      this.config.provisioning?.projectsDir ?? '',
    );

    if (!technicalName || project.provisioningStatus !== 'provisioned') {
      return {
        kind: 'skipped',
        message:
          'This project has no provisioned instance on this host, so there is nothing to ' +
          'back up. Backups cover a client estate, not a remote repository.',
      };
    }

    const script = this.config.provisioning!.backupScript!;
    const startedAt = Date.now();

    const [row] = await this.database.db
      .insert(projectBackups)
      .values({
        projectId,
        taskId: options.taskId ?? null,
        status: 'running',
        reason: options.reason,
        createdByUserId: options.userId ?? null,
      })
      .returning();

    let result;
    try {
      result = await this.commands.run('sudo', ['-n', script, technicalName], {
        cwd: '/',
        // A large instance's dump takes minutes; the process default would kill
        // it mid-write and leave a partial backup behind.
        timeoutMs: this.config.process.maxTimeoutMs,
      });
    } catch (error) {
      return this.markFailed(row.id, projectId, options, (error as Error).message);
    }

    const durationMs = Date.now() - startedAt;

    if (result.exitCode !== 0) {
      const detail = summariseTail(result.stderr || result.stdout);
      return this.markFailed(
        row.id,
        projectId,
        options,
        detail || `The backup script exited with code ${result.exitCode}.`,
      );
    }

    // The script prints its own facts as `KEY=value` lines; read them back
    // rather than guessing paths the platform cannot see (the backup root is
    // root-owned).
    const backupId = /^BACKUP_ID=(.+)$/m.exec(result.stdout)?.[1]?.trim() ?? null;
    const path = /^BACKUP_PATH=(.+)$/m.exec(result.stdout)?.[1]?.trim() ?? null;
    const sizeRaw = /^BACKUP_SIZE_BYTES=(\d+)$/m.exec(result.stdout)?.[1];
    const sizeBytes = sizeRaw ? Number.parseInt(sizeRaw, 10) : null;

    const [completed] = await this.database.db
      .update(projectBackups)
      .set({
        status: 'completed',
        backupId,
        path,
        sizeBytes,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(projectBackups.id, row.id))
      .returning();

    await this.audit.record({
      event: AUDIT_EVENTS.PROJECT_BACKUP_CREATED,
      projectId,
      userId: options.userId ?? null,
      metadata: {
        backupId,
        path,
        sizeBytes,
        reason: options.reason,
        taskId: options.taskId ?? null,
        durationMs,
      },
    });

    this.logger.log(
      `Backup ${backupId ?? row.id} of "${technicalName}" completed in ${durationMs} ms` +
        (sizeBytes === null ? '' : ` (${sizeBytes} bytes)`),
    );

    return { kind: 'taken', backup: toSummary(completed) };
  }

  /** The project's backups, newest first - the list the portal renders. */
  async list(user: AuthenticatedUser, projectId: string): Promise<readonly BackupSummary[]> {
    await this.authz.requireProjectAccess(user, projectId);

    const rows = await this.database.db
      .select()
      .from(projectBackups)
      .where(eq(projectBackups.projectId, projectId))
      .orderBy(desc(projectBackups.createdAt))
      .limit(20);

    return rows.map(toSummary);
  }

  /** A person asking for a backup, from the portal. */
  async request(user: AuthenticatedUser, projectId: string): Promise<BackupOutcome> {
    await this.authz.requireProjectAccess(user, projectId);
    return this.run(projectId, { reason: 'manual', userId: user.userId });
  }

  private async markFailed(
    rowId: string,
    projectId: string,
    options: { readonly reason: BackupReason; readonly taskId?: string | null; readonly userId?: string | null },
    message: string,
  ): Promise<BackupOutcome> {
    const [failed] = await this.database.db
      .update(projectBackups)
      .set({ status: 'failed', error: message.slice(0, 1000), completedAt: new Date(), updatedAt: new Date() })
      .where(eq(projectBackups.id, rowId))
      .returning();

    await this.audit.record({
      event: AUDIT_EVENTS.PROJECT_BACKUP_FAILED,
      projectId,
      userId: options.userId ?? null,
      metadata: { error: message, reason: options.reason, taskId: options.taskId ?? null },
    });

    this.logger.error(`Backup of project ${projectId} failed: ${message}`);

    return { kind: 'failed', message, backup: failed ? toSummary(failed) : null };
  }
}

function toSummary(row: typeof projectBackups.$inferSelect): BackupSummary {
  return {
    id: row.id,
    status: row.status as BackupStatus,
    reason: row.reason as BackupReason,
    backupId: row.backupId,
    path: row.path,
    sizeBytes: row.sizeBytes,
    error: row.error,
    taskId: row.taskId,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

/** The last non-empty line of a script's output, bounded (its own words). */
function summariseTail(value: string): string {
  const lines = value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return (lines[lines.length - 1] ?? '').slice(0, 400);
}
