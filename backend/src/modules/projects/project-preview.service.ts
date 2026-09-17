import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { and, desc, eq, gte, inArray, isNotNull, lte } from 'drizzle-orm';
import { APP_CONFIG } from '../../core/config/config.module';
import type { AppConfig } from '../../core/config/configuration';
import { DatabaseService } from '../../core/database/database.service';
import { agentTasks, projectConnections, projectPreviews, projects } from '../../core/database/schema';
import { SECRETS_PROVIDER, type SecretsProvider } from '../../core/secrets/secrets.provider';
import { AuditService } from '../../core/audit/audit.service';
import { AUDIT_EVENTS } from '../../core/audit/audit-events';
import { AuthorizationService } from '../../core/authz/authorization.service';
import type { AuthenticatedUser } from '../../core/authz/authenticated-user';
import { GIT_CONNECTION_TYPES, type OdooEdition, type ProjectType } from '../../core/enums';
import { CommandRunner } from '../../core/process/command-runner.service';
import { executionModeFor } from '../../agent/executors/execution-mode';
import { deriveDirectoryName } from './odoo-scaffold';
import { technicalNameFromOnPremisePath } from './project-deployment.service';
import {
  decidePreview,
  isPreviewRef,
  previewModules,
  remainingTtlMs,
} from './preview-plan';

/** What the portal renders about one preview. */
export interface PreviewSummary {
  readonly ref: string;
  readonly status: 'creating' | 'ready' | 'failed' | 'stopped';
  readonly url: string | null;
  readonly branch: string;
  readonly error: string | null;
  readonly expiresAt: string;
  readonly ttlRemainingMs: number;
}

export interface PreviewAvailability {
  readonly available: boolean;
  /** Shown when not available, so the portal can explain instead of hiding. */
  readonly reason: string | null;
}

/**
 * The ephemeral preview instance (ADR-052).
 *
 * A preview is a short-lived running Odoo built from a task's retained draft, so
 * a reviewer sees the real UI before approving. This service owns the lifecycle
 * and the database row; the build itself happens in a root-run script
 * (`infrastructure/provisioning/preview-project.sh`), because a preview runs as
 * the `odoo` user under `/opt/odoo/projects`, which this process cannot write to
 * — exactly the reason provisioning and the pull already go through that bridge.
 *
 * The draft is reconstructed from the task's retained patch rather than a live
 * workspace: the workspace is released the moment a run suspends for an approval
 * (ADR-052 §2), so at the moment a reviewer is deciding there is no clone on
 * disk. The patch and a small job file travel to the script through a fixed
 * staging directory; the script reads paths from its own configuration, never
 * from the argument vector.
 */
@Injectable()
export class ProjectPreviewService implements OnModuleInit {
  private readonly logger = new Logger(ProjectPreviewService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly commands: CommandRunner,
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly authz: AuthorizationService,
    @Inject(SECRETS_PROVIDER) private readonly secrets: SecretsProvider,
  ) {}

  /** True when this deployment has the preview script and its sudo grant. */
  get available(): boolean {
    return Boolean(this.config.preview?.enabled && this.config.preview.script);
  }

  /** Whether the portal should offer the action, and why not when it should not. */
  availability(): PreviewAvailability {
    if (this.available) return { available: true, reason: null };
    return {
      available: false,
      reason:
        'Preview is not enabled on this deployment (PROJECT_PREVIEW_SCRIPT is empty, or ' +
        'PROJECT_PROVISIONING_ENABLED is false).',
    };
  }

  /**
   * Builds a preview for a task's draft, replacing any preview this project
   * already has (ADR-052 §5: one per project).
   */
  async start(
    user: AuthenticatedUser,
    projectId: string,
    taskId: string,
  ): Promise<{ preview: PreviewSummary | null; message: string }> {
    await this.authz.requireProjectAccess(user, projectId);

    if (!this.available) {
      throw new BadRequestException(this.availability().reason);
    }

    const [project] = await this.database.db
      .select({
        id: projects.id,
        name: projects.name,
        projectType: projects.projectType,
        odooVersion: projects.odooVersion,
        odooEdition: projects.odooEdition,
        region: projects.region,
        repositoryUrl: projects.repositoryUrl,
        environmentConfig: projects.environmentConfig,
      })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    if (!project) throw new NotFoundException('Project not found');

    const [task] = await this.database.db
      .select({
        id: agentTasks.id,
        branch: agentTasks.branch,
        baseCommit: agentTasks.baseCommit,
        diffPatch: agentTasks.diffPatch,
        diffStats: agentTasks.diffStats,
      })
      .from(agentTasks)
      .where(and(eq(agentTasks.id, taskId), eq(agentTasks.projectId, projectId)))
      .limit(1);

    if (!task) throw new NotFoundException('Task not found on this project');

    const onPremisePath = project.environmentConfig?.onPremisePath;
    const executionMode = executionModeFor(project.projectType as ProjectType, {
      hasLocalDirectory: typeof onPremisePath === 'string' && onPremisePath.length > 0,
      hasRepository: project.repositoryUrl !== null,
    });

    const patch = task.diffPatch ?? '';
    const decision = decidePreview({
      enabled: this.available,
      executionMode,
      patchPresent: patch.length > 0,
      patchTruncated: task.diffStats?.patchTruncated === true,
      hasVersion: typeof project.odooVersion === 'string' && project.odooVersion.length > 0,
    });

    if (!decision.allowed) {
      throw new BadRequestException(decision.reason);
    }

    const technicalName =
      technicalNameFromOnPremisePath(
        project.environmentConfig,
        this.config.provisioning?.projectsDir ?? '',
      ) ?? deriveDirectoryName(project.name);

    if (!technicalName) {
      throw new BadRequestException(
        'This project does not give a usable directory name for a preview.',
      );
    }

    // One per project: the previous preview is torn down before the new one
    // starts, so a host never holds two previews of the same project.
    await this.stopActive(projectId, user.userId, 'replaced');

    const ref = randomBytes(8).toString('hex');
    const port = await this.allocatePort();
    if (port === null) {
      throw new BadRequestException(
        'No free preview port was found in the configured range. Stop another preview, or ' +
          'widen PROJECT_PREVIEW_PORT_RANGE_START/END.',
      );
    }

    const version = project.odooVersion as string;
    const edition = (project.odooEdition ?? 'enterprise') as OdooEdition;
    // The enum stores `south_africa`; the standard-database file names use
    // `south-africa`. Normalising here means the template name the script builds
    // is the same whichever form a row carries.
    const region = (project.region ?? 'indonesia').replace(/-/g, '_');
    const modules = previewModules(patch);
    // The task's branch is null for a task that never reached a checkout; fall
    // back to the project's version is not sensible, so use development.
    const branch = task.branch ?? 'development';
    const baseDomain = this.config.preview.baseDomain;
    const url = baseDomain
      ? `http://preview-${ref}.${baseDomain}`
      : `http://127.0.0.1:${port}`;
    const expiresAt = new Date(Date.now() + this.config.preview.ttlMs);

    await this.writeJob(ref, {
      projectName: technicalName,
      ref,
      port,
      geventPort: port + 1,
      version,
      edition,
      region,
      branch,
      baseCommit: task.baseCommit,
      modules,
      repositoryUrl: project.repositoryUrl,
      url,
    }, patch);

    const [row] = await this.database.db
      .insert(projectPreviews)
      .values({
        projectId,
        taskId,
        ref,
        status: 'creating',
        branch,
        baseCommit: task.baseCommit,
        odooVersion: version,
        odooEdition: edition,
        region,
        port,
        url,
        databaseName: null,
        expiresAt,
        startedByUserId: user.userId,
      })
      .returning();

    const credential = await this.gitCredential(projectId);

    try {
      const result = await this.commands.run(
        'sudo',
        ['-n', this.config.preview!.script!, 'start', technicalName, ref],
        {
          cwd: '/',
          timeoutMs: this.config.process.maxTimeoutMs,
          // The git credential travels on stdin, as the pull does: a token in
          // argv is world-readable through /proc/<pid>/cmdline.
          ...(credential ? { stdin: credential } : {}),
        },
      );

      if (result.exitCode !== 0) {
        const detail =
          summariseTail(result.stderr || result.stdout) || `exit code ${result.exitCode}`;
        await this.markFailed(row.id, detail);
        await this.audit.record({
          event: AUDIT_EVENTS.PROJECT_PREVIEW_FAILED,
          projectId,
          userId: user.userId,
          metadata: { ref, error: detail },
        });
        return {
          preview: null,
          message: `The preview could not be built: ${detail}`,
        };
      }

      const printedUrl = /PREVIEW URL:\s*(\S+)/.exec(result.stdout)?.[1] ?? url;
      const databaseName =
        /PREVIEW DATABASE:\s*(\S+)/.exec(result.stdout)?.[1] ?? null;

      await this.database.db
        .update(projectPreviews)
        .set({ status: 'ready', url: printedUrl, databaseName, updatedAt: new Date() })
        .where(eq(projectPreviews.id, row.id));

      await this.audit.record({
        event: AUDIT_EVENTS.PROJECT_PREVIEW_STARTED,
        projectId,
        userId: user.userId,
        metadata: { ref, url: printedUrl, branch, modules },
      });

      return {
        preview: this.toSummary({ ...row, status: 'ready', url: printedUrl }, Date.now()),
        message: `Preview is ready at ${printedUrl}. It will be torn down automatically.`,
      };
    } catch (error) {
      const detail = (error as Error).message;
      await this.markFailed(row.id, detail);
      await this.audit.record({
        event: AUDIT_EVENTS.PROJECT_PREVIEW_FAILED,
        projectId,
        userId: user.userId,
        metadata: { ref, error: detail },
      });
      return { preview: null, message: `The preview could not be built: ${detail}` };
    }
  }

  /** The project's live preview, if any. Expired previews are stopped on read. */
  async status(
    user: AuthenticatedUser,
    projectId: string,
  ): Promise<{ available: boolean; reason: string | null; preview: PreviewSummary | null }> {
    await this.authz.requireProjectAccess(user, projectId);

    const availability = this.availability();
    const row = await this.activeRow(projectId);
    if (!row) return { ...availability, preview: null };

    if (row.expiresAt.getTime() <= Date.now()) {
      await this.stopActive(projectId, user.userId, 'expired');
      return { ...availability, preview: null };
    }

    return { ...availability, preview: this.toSummary(row, Date.now()) };
  }

  /** Tears down the project's preview, if one is live. */
  async stop(
    user: AuthenticatedUser,
    projectId: string,
  ): Promise<{ stopped: boolean; message: string }> {
    await this.authz.requireProjectAccess(user, projectId);

    const row = await this.activeRow(projectId);
    if (!row) return { stopped: false, message: 'There is no live preview for this project.' };

    await this.stopActive(projectId, user.userId, 'stopped');
    return { stopped: true, message: 'The preview instance was torn down.' };
  }

  /**
   * Stops previews whose TTL has passed or whose worker died mid-build.
   *
   * Called at boot, the same shape as the workspace reclaimer: a row in
   * `creating` with an expiry in the past is an orphan, and a preview is a
   * database and a process that must not outlive its owner.
   */
  async onModuleInit(): Promise<void> {
    if (!this.available) return;
    try {
      const stale = await this.database.db
        .select({ projectId: projectPreviews.projectId, ref: projectPreviews.ref })
        .from(projectPreviews)
        .where(
          and(
            inArray(projectPreviews.status, ['creating', 'ready']),
            lte(projectPreviews.expiresAt, new Date()),
          ),
        );

      for (const row of stale) {
        await this.stopActive(row.projectId, null, 'expired');
      }
      if (stale.length > 0) {
        this.logger.warn(`Reclaimed ${stale.length} expired preview instance(s) at startup.`);
      }
    } catch (error) {
      this.logger.warn(`Could not reclaim expired previews at startup: ${(error as Error).message}`);
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async activeRow(projectId: string) {
    const [row] = await this.database.db
      .select()
      .from(projectPreviews)
      .where(
        and(
          eq(projectPreviews.projectId, projectId),
          inArray(projectPreviews.status, ['creating', 'ready']),
        ),
      )
      .orderBy(desc(projectPreviews.createdAt))
      .limit(1);
    return row ?? null;
  }

  /** Stops every live preview for a project and marks it stopped. */
  private async stopActive(
    projectId: string,
    userId: string | null,
    reason: 'replaced' | 'stopped' | 'expired',
  ): Promise<void> {
    const live = await this.database.db
      .select({ id: projectPreviews.id, ref: projectPreviews.ref })
      .from(projectPreviews)
      .where(
        and(
          eq(projectPreviews.projectId, projectId),
          inArray(projectPreviews.status, ['creating', 'ready']),
        ),
      );

    for (const row of live) {
      const technicalName = await this.technicalNameFor(projectId);
      if (technicalName && this.config.preview?.script) {
        try {
          await this.commands.run(
            'sudo',
            ['-n', this.config.preview.script, 'stop', technicalName, row.ref],
            { cwd: '/', timeoutMs: this.config.process.maxTimeoutMs },
          );
        } catch (error) {
          // A stop that fails is logged, not fatal: the reaper and an operator
          // both have the row and the ref, so the instance is still findable.
          this.logger.warn(`Preview stop for ${row.ref} failed: ${(error as Error).message}`);
        }
      }

      await this.database.db
        .update(projectPreviews)
        .set({ status: 'stopped', updatedAt: new Date() })
        .where(eq(projectPreviews.id, row.id));

      await this.removeJob(row.ref);
    }

    if (live.length > 0) {
      await this.audit.record({
        event: AUDIT_EVENTS.PROJECT_PREVIEW_STOPPED,
        projectId,
        userId,
        metadata: { reason, refs: live.map((row) => row.ref) },
      });
    }
  }

  private async markFailed(id: string, error: string): Promise<void> {
    await this.database.db
      .update(projectPreviews)
      .set({ status: 'failed', error: error.slice(0, 2000), updatedAt: new Date() })
      .where(eq(projectPreviews.id, id));
  }

  private async technicalNameFor(projectId: string): Promise<string | null> {
    const [project] = await this.database.db
      .select({ name: projects.name, environmentConfig: projects.environmentConfig })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!project) return null;

    return (
      technicalNameFromOnPremisePath(
        project.environmentConfig,
        this.config.provisioning?.projectsDir ?? '',
      ) ?? deriveDirectoryName(project.name)
    );
  }

  private async writeJob(
    ref: string,
    job: Record<string, unknown>,
    patch: string,
  ): Promise<void> {
    const dir = this.config.preview.stagingDir;
    if (!isPreviewRef(ref)) {
      throw new BadRequestException('The generated preview reference was not valid.');
    }
    await mkdir(dir, { recursive: true });
    const jobPath = join(dir, `${ref}.json`);
    const patchPath = join(dir, `${ref}.patch`);
    await writeFile(jobPath, JSON.stringify(job, null, 2), { mode: 0o600 });
    await writeFile(patchPath, patch, { mode: 0o600 });
    // writeFile's mode is subject to umask on some systems; be explicit.
    await chmod(jobPath, 0o600).catch(() => undefined);
    await chmod(patchPath, 0o600).catch(() => undefined);
  }

  private async removeJob(ref: string): Promise<void> {
    const dir = this.config.preview.stagingDir;
    await rm(join(dir, `${ref}.json`), { force: true }).catch(() => undefined);
    await rm(join(dir, `${ref}.patch`), { force: true }).catch(() => undefined);
  }

  private toSummary(
    row: {
      ref: string;
      status: string;
      url: string | null;
      branch: string;
      error: string | null;
      expiresAt: Date;
    },
    now: number,
  ): PreviewSummary {
    return {
      ref: row.ref,
      status: row.status as PreviewSummary['status'],
      url: row.url,
      branch: row.branch,
      error: row.error,
      expiresAt: row.expiresAt.toISOString(),
      ttlRemainingMs: remainingTtlMs(row.expiresAt, now),
    };
  }

  /**
   * Picks two consecutive free ports in the preview range (HTTP, then gevent).
   *
   * Mirrors the project allocator's reasoning at a smaller scale: the platform's
   * own rows are checked first, then the host, because a leftover service the
   * database does not know about is exactly what a preview must not collide with.
   */
  private async allocatePort(): Promise<number | null> {
    const { portRangeStart, portRangeEnd } = this.config.preview;

    const taken = await this.database.db
      .select({ port: projectPreviews.port })
      .from(projectPreviews)
      .where(
        and(
          inArray(projectPreviews.status, ['creating', 'ready']),
          gte(projectPreviews.port, portRangeStart),
          lte(projectPreviews.port, portRangeEnd),
        ),
      );
    const takenPorts = new Set(
      taken.map((row) => row.port).filter((port): port is number => port !== null),
    );

    for (let port = portRangeStart; port + 1 <= portRangeEnd; port += 2) {
      if (takenPorts.has(port) || takenPorts.has(port + 1)) continue;
      if ((await this.isPortFree(port)) && (await this.isPortFree(port + 1))) return port;
    }

    return null;
  }

  private async isPortFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = createConnection({ port, host: '127.0.0.1' });
      const settle = (free: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(free);
      };
      socket.once('connect', () => settle(false));
      socket.once('error', () => settle(true));
      socket.setTimeout(500, () => settle(true));
    });
  }

  private async gitCredential(projectId: string): Promise<string | null> {
    const [connection] = await this.database.db
      .select({ secretRef: projectConnections.secretRef })
      .from(projectConnections)
      .where(
        and(
          eq(projectConnections.projectId, projectId),
          isNotNull(projectConnections.secretRef),
          inArray(projectConnections.connectionType, [...GIT_CONNECTION_TYPES]),
        ),
      )
      .orderBy(projectConnections.createdAt)
      .limit(1);

    if (!connection?.secretRef) return null;
    try {
      return await this.secrets.read(connection.secretRef);
    } catch (error) {
      this.logger.warn(
        `Could not read the git credential for project ${projectId}: ${(error as Error).message}`,
      );
      return null;
    }
  }
}

function summariseTail(value: string): string {
  const lines = value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return (lines[lines.length - 1] ?? '').slice(0, 400);
}
