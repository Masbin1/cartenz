import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { readdir } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { APP_CONFIG } from '../../core/config/config.module';
import type { AppConfig } from '../../core/config/configuration';
import { DatabaseService } from '../../core/database/database.service';
import { projectConnections, projects } from '../../core/database/schema';
import { CommandRunner } from '../../core/process/command-runner.service';
import { AuditService } from '../../core/audit/audit.service';
import { AUDIT_EVENTS } from '../../core/audit/audit-events';
import { SECRETS_PROVIDER, type SecretsProvider } from '../../core/secrets/secrets.provider';
import { GIT_CONNECTION_TYPES } from '../../core/enums';
import type { AuthenticatedUser } from '../../core/authz/authenticated-user';
import { AuthorizationService } from '../../core/authz/authorization.service';
import { effectiveRepositoryUrl } from './repository-url';
import { ProjectProvisioningQueue, type RestoredInstanceJobData } from './project-provisioning.queue';

export interface RestoreAvailability {
  readonly available: boolean;
  readonly reason: string | null;
}

/**
 * A restored copy of a connected project's odoo.sh instance (ADR-067).
 *
 * Connecting an existing odoo.sh project never reaches the customer's own
 * instance (ADR-050): this platform's only access to odoo.sh is a git push, so
 * there is nothing on the customer side it could connect *to*. What an
 * operator does instead: download a backup zip from odoo.sh, place it in one
 * fixed staging directory, and ask for a restore. This service enqueues a root
 * script (`restore-existing-instance.sh`) that builds a brand-new Odoo instance
 * and database on this host, loads the zip with Odoo's own loader, and
 * neutralizes it before it ever starts - the instance is for a human operator
 * to look at, never a target the agent works against. A task keeps running on
 * the project's own template-built database throughout (ADR-050 §3); nothing
 * here changes that.
 *
 * Deliberately not reachable twice: `restoredStatus` moves 'none' -> 'pending'
 * -> 'restored' | 'failed', and asking again while an instance already exists
 * is refused (drop it first, from the systemd/database layer, by hand — there
 * is no delete path yet because nothing has needed one).
 */
@Injectable()
export class ProjectRestoreService {
  private readonly logger = new Logger(ProjectRestoreService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly commands: CommandRunner,
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly queue: ProjectProvisioningQueue,
    private readonly authz: AuthorizationService,
    @Inject(SECRETS_PROVIDER) private readonly secrets: SecretsProvider,
  ) {}

  /** True when this deployment has the restore script and its sudo grant. */
  get available(): boolean {
    return Boolean(this.config.provisioning?.enabled && this.config.provisioning.restoreScript);
  }

  availability(): RestoreAvailability {
    if (this.available) return { available: true, reason: null };
    return {
      available: false,
      reason:
        'Restoring a backup is not enabled on this deployment (PROJECT_RESTORE_SCRIPT is ' +
        'empty, or PROJECT_PROVISIONING_ENABLED is false).',
    };
  }

  /**
   * The odoo.sh backup zips currently sitting in the staging directory.
   *
   * Listed by this process directly (not through the root script) purely so
   * the portal can offer a picker instead of asking an operator to type a file
   * name exactly. The directory this reads is the platform's own — created and
   * owned by this process, distinct from any project's `odoo:odoo` directory —
   * so no elevated access is needed to list it.
   */
  /** The staged zips, for a person who may open this project. */
  async listFor(user: AuthenticatedUser, projectId: string): Promise<readonly string[]> {
    await this.authz.requireProjectAccess(user, projectId, { requireAdmin: true });
    return this.availableBackups();
  }

  async availableBackups(): Promise<readonly string[]> {
    const dir = this.config.provisioning?.restoreStagingDir;
    if (!dir) return [];
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.zip'))
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      this.logger.warn(`Could not list ${dir}: ${(error as Error).message}`);
      return [];
    }
  }

  /**
   * A person asking to restore one project's odoo.sh backup into a new,
   * Cartenz-owned instance.
   *
   * Queued rather than inline: loading a real customer database routinely
   * takes minutes, well past PROCESS_MAX_TIMEOUT_MS. `restoredStatus` is
   * recorded as 'pending' before the job is queued, for the same reason a
   * restart's status is: the portal's first poll must see 'pending', not
   * whatever a previous attempt left behind.
   */
  async request(
    user: AuthenticatedUser,
    projectId: string,
    backupFilename: string,
  ): Promise<{ readonly queued: true; readonly instanceName: string }> {
    // Admin-gated like a restart: this puts real customer data on this host.
    await this.authz.requireProjectAccess(user, projectId, { requireAdmin: true });
    const userId = user.userId;

    if (!this.available) {
      throw new BadRequestException(this.availability().reason ?? 'Restore is not enabled.');
    }

    // Refused here, before anything is recorded, when the file is not actually
    // in the staging directory: otherwise the row sits on 'pending' until the
    // worker reaches the script and the script says the same thing.
    const staged = await this.availableBackups();
    if (!staged.includes(backupFilename)) {
      throw new BadRequestException(
        `No backup named "${backupFilename}" in ${this.config.provisioning!.restoreStagingDir}. ` +
          'Copy the odoo.sh zip there first.',
      );
    }

    const [project] = await this.database.db
      .select({
        name: projects.name,
        repositoryUrl: projects.repositoryUrl,
        defaultBranch: projects.defaultBranch,
        restoredStatus: projects.restoredStatus,
      })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    if (!project) {
      throw new NotFoundException('Project not found.');
    }

    if (project.restoredStatus === 'pending') {
      throw new ConflictException('A restore is already running for this project.');
    }
    if (project.restoredStatus === 'restored') {
      throw new ConflictException(
        'This project already has a restored instance. Remove it on the host before ' +
          'restoring again.',
      );
    }

    // Optional: a repository, when this project has one, so the customer's own
    // modules are on the addons path when the restored database first loads.
    // Absent for a project connected purely to look at data — not an error.
    const connections = await this.database.db
      .select({
        connectionType: projectConnections.connectionType,
        metadata: projectConnections.metadata,
      })
      .from(projectConnections)
      .where(eq(projectConnections.projectId, projectId));
    const repositoryUrl = effectiveRepositoryUrl(project.repositoryUrl, connections);

    const instanceName = deriveInstanceName(project.name, projectId);

    await this.database.db
      .update(projects)
      .set({
        restoredStatus: 'pending',
        restoredError: null,
        restoredInstanceName: instanceName,
        restoredBackupFile: backupFilename,
        restoredPort: null,
      })
      .where(eq(projects.id, projectId));

    try {
      await this.queue.enqueueRestoredInstance({
        projectId,
        userId,
        instanceName,
        backupFilename,
        repositoryUrl: repositoryUrl ?? null,
        branch: repositoryUrl ? project.defaultBranch : null,
      });
    } catch (error) {
      // Never leave the row on 'pending' for a job that was never queued.
      await this.markFailed(projectId, `Could not queue the restore: ${(error as Error).message}`);
      throw error;
    }

    await this.audit.record({
      event: AUDIT_EVENTS.PROJECT_RESTORED_INSTANCE_REQUESTED,
      projectId,
      userId,
      metadata: { instanceName, backupFilename },
    });

    return { queued: true, instanceName };
  }

  /**
   * The worker's half of a restore (mirrors `completeRestart`'s contract):
   * never throws, every outcome lands on the project row, which is what the
   * portal polls.
   */
  async complete(data: RestoredInstanceJobData): Promise<void> {
    const startedAt = Date.now();

    if (!this.available) {
      await this.markFailed(data.projectId, this.availability().reason ?? 'Restore disabled.');
      return;
    }

    const port = await this.allocatePort();
    if (port === null) {
      await this.markFailed(data.projectId, 'No free port in the configured provisioning range.');
      return;
    }

    const args = [
      '-n',
      this.config.provisioning!.restoreScript!,
      data.instanceName,
      String(port),
      data.backupFilename,
      ...(data.repositoryUrl ? [data.repositoryUrl, data.branch!] : []),
    ];

    // The credential travels on stdin, never in argv, exactly as the pull and
    // restart pass it: /proc/<pid>/cmdline is world-readable on this host.
    const credential = data.repositoryUrl ? await this.gitCredential(data.projectId) : null;

    let result;
    try {
      result = await this.commands.run('sudo', args, {
        cwd: '/',
        // A real customer database can take several minutes to load.
        timeoutMs: this.config.process.maxTimeoutMs,
        ...(credential ? { stdin: credential } : {}),
      });
    } catch (error) {
      await this.markFailed(data.projectId, (error as Error).message);
      return;
    }

    const durationMs = Date.now() - startedAt;

    if (result.exitCode !== 0) {
      const detail = summariseTail(result.stderr || result.stdout);
      await this.markFailed(
        data.projectId,
        detail || `The restore script exited with code ${result.exitCode}.`,
      );
      return;
    }

    await this.database.db
      .update(projects)
      .set({
        restoredStatus: 'restored',
        restoredPort: port,
        restoredError: null,
        restoredAt: new Date(),
      })
      .where(eq(projects.id, data.projectId));

    await this.audit.record({
      event: AUDIT_EVENTS.PROJECT_RESTORED_INSTANCE_CREATED,
      projectId: data.projectId,
      userId: data.userId,
      metadata: { instanceName: data.instanceName, port, backupFilename: data.backupFilename, durationMs },
    });

    this.logger.log(
      `Restored instance "${data.instanceName}" from "${data.backupFilename}" on port ${port} ` +
        `in ${durationMs} ms`,
    );
  }

  private async markFailed(projectId: string, message: string): Promise<void> {
    await this.database.db
      .update(projects)
      .set({ restoredStatus: 'failed', restoredError: message.slice(0, 1000) })
      .where(eq(projects.id, projectId));

    await this.audit.record({
      event: AUDIT_EVENTS.PROJECT_RESTORED_INSTANCE_FAILED,
      projectId,
      userId: null,
      metadata: { error: message },
    });

    this.logger.error(`Restore for project ${projectId} failed: ${message}`);
  }

  /**
   * Picks the lowest free port in the configured provisioning range.
   *
   * Deliberately re-implemented here rather than shared with
   * `ProjectProvisioningService.allocatePort`: that method is private, checks
   * `projects.provisioningPort`, and this needs `projects.restoredPort` — a
   * separate column so a restored copy can never collide with, or be mistaken
   * for, the project's own provisioned instance.
   */
  private async allocatePort(): Promise<number | null> {
    const { portRangeStart, portRangeEnd } = this.config.provisioning!;

    const [provisioned, restored] = await Promise.all([
      this.database.db.select({ port: projects.provisioningPort }).from(projects),
      this.database.db.select({ port: projects.restoredPort }).from(projects),
    ]);
    const taken = new Set(
      [...provisioned, ...restored]
        .map((row) => row.port)
        .filter((port): port is number => port !== null),
    );

    for (let port = portRangeStart; port + 1 <= portRangeEnd; port += 2) {
      if (taken.has(port) || taken.has(port + 1)) continue;
      if ((await isPortFree(port)) && (await isPortFree(port + 1))) return port;
    }
    return null;
  }

  /** The project's git credential, when it has one (same selection as a pull). */
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

/** True when nothing on this host is already listening on the given port. */
function isPortFree(port: number): Promise<boolean> {
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

/**
 * Derives a stable systemd/database-safe name for the restored instance.
 *
 * Distinct from the project's own technical name (never the same string): the
 * two are different instances on the same host, and a collision would make one
 * script's project-directory guard reject the other's.
 */
function deriveInstanceName(projectName: string, projectId: string): string {
  const slug = projectName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 20);
  const suffix = projectId.replace(/-/g, '').slice(0, 8);
  const base = slug || 'restored';
  return `${base}-r-${suffix}`;
}

function summariseTail(output: string, maxLines = 15): string {
  const lines = output.trim().split('\n');
  return lines.slice(-maxLines).join('\n').slice(0, 2000);
}
