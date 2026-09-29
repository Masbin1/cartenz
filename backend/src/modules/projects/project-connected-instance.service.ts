import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { createConnection } from 'node:net';
import { APP_CONFIG } from '../../core/config/config.module';
import type { AppConfig } from '../../core/config/configuration';
import { DatabaseService } from '../../core/database/database.service';
import { projectConnections, projects } from '../../core/database/schema';
import { CommandRunner } from '../../core/process/command-runner.service';
import { AuditService } from '../../core/audit/audit.service';
import { AUDIT_EVENTS } from '../../core/audit/audit-events';
import { SECRETS_PROVIDER, type SecretsProvider } from '../../core/secrets/secrets.provider';
import { GIT_CONNECTION_TYPES, type OdooEdition, type UserRegion } from '../../core/enums';
import type { AuthenticatedUser } from '../../core/authz/authenticated-user';
import { AuthorizationService } from '../../core/authz/authorization.service';
import { effectiveRepositoryUrl } from './repository-url';
import {
  ProjectProvisioningQueue,
  type ConnectedInstanceJobData,
} from './project-provisioning.queue';

export interface ConnectedInstanceAvailability {
  readonly available: boolean;
  readonly reason: string | null;
}

/**
 * A provisioned instance for a connected project (ADR-069).
 *
 * Connecting an existing odoo.sh project gives the platform a repository and
 * nothing else (ADR-050): there is no customer instance it could reach, and
 * ADR-067's restored copy exists for a *person* to inspect real data, locked
 * to localhost. This is the other, separate ask: stand up the project's own
 * empty Odoo instance on this host, reachable over HTTPS, so the project owner
 * can open `/web/database/manager` and restore their own backup into it.
 *
 * No new root script. The chain is exactly the one "Create with AI" already
 * runs, triggered from a connected project instead of project creation:
 *
 *   1. `create_project[_enterprise] <name> <port> <version> <region>` —
 *      directory, database cloned from the standard template, systemd unit,
 *      Nginx site. `list_db` stays True there, which is what makes the
 *      database manager reachable for the owner.
 *   2. `grant-addons-write.sh <name>` — the same ownership fix-up every
 *      provisioned project needs.
 *   3. `pull-project.sh <name> <repositoryUrl> <branch>` — only when a
 *      repository is connected; the credential travels on stdin.
 *   4. `setup-project-https.sh <name> <domain> <email>` — ADR-040's script,
 *      reused unchanged, so the project's link is `https://` as asked.
 *
 * The instance is never recorded as the project's own on-premise path and no
 * task, validation or preview path reads `connected_instance_*`: the agent
 * keeps working against the project's standard template database, exactly as
 * ADR-050 §3 requires.
 */
@Injectable()
export class ProjectConnectedInstanceService {
  private readonly logger = new Logger(ProjectConnectedInstanceService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly commands: CommandRunner,
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly queue: ProjectProvisioningQueue,
    private readonly authz: AuthorizationService,
    @Inject(SECRETS_PROVIDER) private readonly secrets: SecretsProvider,
  ) {}

  /**
   * True when this deployment can provision at all. HTTPS and a base domain
   * are deliberately part of the same gate rather than separate, softer checks:
   * the operator's requirement for this feature is an `https://` link, and a
   * domain is what an `https://` link is issued for, so a deployment missing
   * either must refuse the request up front instead of handing back a plain
   * URL the way `create_project` tolerates.
   */
  get available(): boolean {
    return Boolean(
      this.config.provisioning?.enabled &&
      this.config.provisioning.baseDomain &&
      this.config.https?.enabled &&
      this.config.https.email,
    );
  }

  availability(): ConnectedInstanceAvailability {
    if (this.available) return { available: true, reason: null };
    const reason = !this.config.provisioning?.enabled
      ? 'Provisioning is not enabled on this deployment (PROJECT_PROVISIONING_ENABLED is false).'
      : !this.config.provisioning.baseDomain
        ? 'No base domain is configured on this deployment (PROJECT_BASE_DOMAIN is empty), and ' +
          'this feature creates an instance on a domain it can issue HTTPS for.'
        : 'HTTPS issuance is not enabled on this deployment (PROJECT_HTTPS_ENABLED is false or ' +
          'PROJECT_HTTPS_EMAIL is empty), and this feature requires an https:// instance.';
    return { available: false, reason };
  }

  /**
   * A person asking for this project's own instance.
   *
   * Admin-gated like a restore: it puts a new running Odoo and a listening
   * Nginx site on this host. Queued rather than inline because the chain runs
   * a real Odoo database duplication and a certbot issuance, both well past
   * `PROCESS_MAX_TIMEOUT_MS`.
   */
  async request(
    user: AuthenticatedUser,
    projectId: string,
  ): Promise<{
    readonly queued: true;
    readonly instanceName: string;
    readonly port: number;
  }> {
    await this.authz.requireProjectAccess(user, projectId, {
      requireAdmin: true,
    });

    if (!this.available) {
      throw new BadRequestException(this.availability().reason ?? 'This feature is not enabled.');
    }

    const [project] = await this.database.db
      .select({
        name: projects.name,
        projectType: projects.projectType,
        odooVersion: projects.odooVersion,
        odooEdition: projects.odooEdition,
        region: projects.region,
        defaultBranch: projects.defaultBranch,
        repositoryUrl: projects.repositoryUrl,
        connectedInstanceStatus: projects.connectedInstanceStatus,
        connectedInstanceName: projects.connectedInstanceName,
        connectedInstancePort: projects.connectedInstancePort,
      })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    if (!project) throw new NotFoundException('Project not found.');

    if (project.projectType !== 'odoo_sh') {
      throw new BadRequestException(
        'Only a connected odoo.sh project can have its own instance. An ai_project is ' +
          'provisioned when it is created, and an odoo_online project keeps its own instance.',
      );
    }

    if (!project.odooVersion) {
      throw new BadRequestException(
        'This project has no Odoo version recorded, so no standard database can be selected ' +
          'for its instance. Set the version in project settings first.',
      );
    }

    if (project.connectedInstanceStatus === 'pending') {
      throw new ConflictException('This project’s instance is already being created.');
    }
    if (project.connectedInstanceStatus === 'ready') {
      throw new ConflictException(
        'This project already has its own instance. Remove it on the host before creating another.',
      );
    }

    /**
     * A `failed` row whose instance directory is still on the host cannot be
     * retried under the same name: `create_project` refuses a path that
     * already exists, so the retry would fail on the first step and leave the
     * operator with nothing to click. Reuse the name the failed attempt
     * recorded instead of deriving a fresh one, so the retry lands on the
     * same directory, unit and Nginx site the script can now complete.
     */
    const instanceName =
      project.connectedInstanceStatus === 'failed' && project.connectedInstanceName
        ? project.connectedInstanceName
        : deriveInstanceName(project.name, projectId);

    /**
     * A failure after the create step also leaves the recorded port occupied
     * by the half-built instance's own systemd unit, so the allocator would
     * step over the one port the retry needs. Reuse the recorded port then.
     */
    const port =
      project.connectedInstanceStatus === 'failed' && project.connectedInstancePort
        ? project.connectedInstancePort
        : await this.allocatePort();

    if (port === null) {
      throw new ConflictException(
        'No free port was found in the configured range ' +
          `${this.config.provisioning!.portRangeStart}-${this.config.provisioning!.portRangeEnd}. ` +
          'Widen PROJECT_PORT_RANGE_START/END, or free a port.',
      );
    }

    // Same selection a pull or a restart makes: the oldest git-capable
    // connection. Absent, the instance is provisioned without the customer's
    // modules and an operator can pull later with the existing button.
    const connections = await this.database.db
      .select({
        connectionType: projectConnections.connectionType,
        metadata: projectConnections.metadata,
      })
      .from(projectConnections)
      .where(eq(projectConnections.projectId, projectId));
    const repositoryUrl = effectiveRepositoryUrl(project.repositoryUrl, connections);

    await this.database.db
      .update(projects)
      .set({
        connectedInstanceStatus: 'pending',
        connectedInstanceName: instanceName,
        connectedInstancePort: port,
        connectedInstanceUrl: null,
        connectedInstanceError: null,
        connectedInstanceCreatedAt: null,
      })
      .where(eq(projects.id, projectId));

    await this.audit.record({
      event: AUDIT_EVENTS.PROJECT_CONNECTED_INSTANCE_REQUESTED,
      projectId,
      userId: user.userId,
      metadata: { instanceName, port },
    });

    /**
     * Enqueued after the row update commits, never before: the job payload
     * needs the state this row now records, and the worker re-reads the row
     * rather than trusting the payload for anything but what was promised.
     */
    await this.queue.enqueueConnectedInstance({
      projectId,
      userId: user.userId,
      instanceName,
      port,
      odooEdition: (project.odooEdition ?? 'community') as OdooEdition,
      odooVersion: project.odooVersion,
      region: (project.region ?? 'indonesia') as UserRegion,
      repositoryUrl: repositoryUrl ?? null,
      branch: repositoryUrl ? (project.defaultBranch ?? 'main') : null,
    });

    this.logger.log(
      `Connected instance "${instanceName}" queued for project ${projectId} on port ${port}`,
    );
    return { queued: true, instanceName, port };
  }

  /**
   * The worker-side half: run the chain and record the outcome.
   *
   * Never throws — there is no request to fail. Every outcome is written onto
   * the project row, which is what the portal polls, exactly as
   * `ProjectRestoreService.complete` does.
   */
  async complete(data: ConnectedInstanceJobData): Promise<void> {
    const startedAt = Date.now();

    const script =
      data.odooEdition === 'enterprise'
        ? this.config.provisioning!.enterpriseScript
        : this.config.provisioning!.communityScript;

    this.logger.log(
      `Creating instance "${data.instanceName}" (${data.odooEdition}) on port ${data.port}`,
    );

    const args = [
      '-n',
      script,
      data.instanceName,
      String(data.port),
      data.odooVersion,
      data.region,
    ];
    const created = await this.runStep('create', args);
    if (!created.ok) return void (await this.markFailed(data.projectId, created.error));

    const granted = await this.runStep('grant', [
      '-n',
      this.config.provisioning!.grantScript,
      data.instanceName,
    ]);
    if (!granted.ok) return void (await this.markFailed(data.projectId, granted.error));

    /**
     * The repository checkout is best-effort, deliberately: an instance that
     * runs on the standard template's own addons is a working instance, and
     * refusing the whole provisioning over a git credential would leave a
     * half-built host with no way to retry. The failure is recorded on the row
     * as a warning-shaped error once the instance is marked ready below.
     */
    let repositoryError: string | null = null;
    if (data.repositoryUrl && this.config.provisioning!.pullScript) {
      const credential = await this.gitCredential(data.projectId);
      const pulled = await this.runStep(
        'pull',
        [
          '-n',
          this.config.provisioning!.pullScript,
          data.instanceName,
          data.repositoryUrl,
          data.branch ?? 'main',
        ],
        credential,
      );
      if (!pulled.ok) {
        repositoryError = pulled.error;
        this.logger.warn(
          `Instance "${data.instanceName}" was created but its repository was not pulled: ${pulled.error}`,
        );
      }
    } else if (data.repositoryUrl) {
      repositoryError =
        'No project-pull script is configured on this deployment (PROJECT_PULL_SCRIPT).';
      this.logger.warn(
        `Instance "${data.instanceName}" was created without pulling its repository: ${repositoryError}`,
      );
    }

    /**
     * HTTPS is not best-effort here (ADR-069): the whole point of this feature
     * is the https link. A failed issuance is a failed request, and the row
     * says so — the instance itself is left running for an operator to retry
     * issuance against, which is what `setup-project-https.sh` is idempotent
     * enough to allow.
     */
    const domain = `${data.instanceName}.${this.config.provisioning!.baseDomain}`;
    const https = await this.runStep('https', [
      '-n',
      this.config.https.script,
      data.instanceName,
      domain,
      this.config.https!.email!,
    ]);
    if (!https.ok) return void (await this.markFailed(data.projectId, https.error));

    const url = `https://${domain}`;

    // The master password is printed by create_project and sealed here, never
    // logged and never returned beyond the reveal endpoint (ADR-040's shape).
    let masterPasswordRef: string | null = null;
    const masterPassword = parseMasterPassword(created.stdout);
    if (masterPassword) {
      try {
        const sealed = await this.secrets.write({
          projectId: data.projectId,
          purpose: 'odoo-master-password',
          value: masterPassword,
        });
        masterPasswordRef = sealed.ref;
      } catch (error) {
        this.logger.error(
          `Could not seal the master password for "${data.instanceName}": ` +
            `${(error as Error).message}. Recover it from ` +
            `${this.config.provisioning!.projectsDir}/${data.instanceName}/config/odoo.conf`,
        );
      }
    } else {
      this.logger.warn(
        `create_project printed no master password for "${data.instanceName}"; recover it from ` +
          `${this.config.provisioning!.projectsDir}/${data.instanceName}/config/odoo.conf`,
      );
    }

    const durationMs = Date.now() - startedAt;

    await this.database.db
      .update(projects)
      .set({
        connectedInstanceStatus: 'ready',
        connectedInstanceUrl: url,
        connectedInstanceError: repositoryError
          ? `The instance is running, but its repository was not checked out: ${repositoryError}`
          : null,
        connectedInstanceMasterPasswordRef: masterPasswordRef,
        connectedInstanceCreatedAt: new Date(),
      })
      .where(eq(projects.id, data.projectId));

    await this.audit.record({
      event: AUDIT_EVENTS.PROJECT_CONNECTED_INSTANCE_CREATED,
      projectId: data.projectId,
      userId: data.userId,
      metadata: {
        instanceName: data.instanceName,
        port: data.port,
        url,
        repositoryPulled: data.repositoryUrl ? repositoryError === null : false,
        durationMs,
      },
    });

    this.logger.log(
      `Instance "${data.instanceName}" is ready at ${url} (port ${data.port}) in ${durationMs} ms`,
    );
  }

  /**
   * Reveals this instance's master password to an admin, audited like every
   * other security-relevant read. Separate from the create_project reveal
   * endpoint because the two instances are different machines' worth of
   * credentials and a reader must not be able to confuse them.
   */
  async revealMasterPassword(user: AuthenticatedUser, projectId: string) {
    await this.authz.requireProjectAccess(user, projectId, {
      requireAdmin: true,
    });

    const [project] = await this.database.db
      .select({ ref: projects.connectedInstanceMasterPasswordRef })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    if (!project) throw new NotFoundException('Project not found.');
    if (!project.ref) {
      throw new NotFoundException(
        'No master password is held for this project’s own instance. It may not have been ' +
          'created yet, or it was created before the password could be sealed.',
      );
    }

    const masterPassword = await this.secrets.read(project.ref);

    await this.audit.record({
      event: AUDIT_EVENTS.PROJECT_CONNECTED_INSTANCE_PASSWORD_REVEALED,
      projectId,
      userId: user.userId,
    });

    return { masterPassword };
  }

  /** Runs one step of the chain, never throwing. */
  private async runStep(
    step: string,
    args: readonly string[],
    stdin?: string | null,
  ): Promise<{ ok: true; stdout: string; stderr: string } | { ok: false; error: string }> {
    try {
      const result = await this.commands.run('sudo', [...args], {
        cwd: '/',
        timeoutMs: this.config.process.maxTimeoutMs,
        ...(stdin ? { stdin } : {}),
      });

      if (result.exitCode !== 0) {
        const detail = summariseTail(result.stderr || result.stdout);
        return {
          ok: false,
          error: `The ${step} step failed: ${detail || `exit code ${result.exitCode}`}`,
        };
      }
      return { ok: true, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      return {
        ok: false,
        error: `The ${step} step failed: ${(error as Error).message}`,
      };
    }
  }

  private async markFailed(projectId: string, message: string): Promise<void> {
    await this.database.db
      .update(projects)
      .set({
        connectedInstanceStatus: 'failed',
        connectedInstanceError: message.slice(0, 1000),
      })
      .where(eq(projects.id, projectId));

    await this.audit.record({
      event: AUDIT_EVENTS.PROJECT_CONNECTED_INSTANCE_FAILED,
      projectId,
      userId: null,
      metadata: { error: message },
    });

    this.logger.error(`Connected instance for project ${projectId} failed: ${message}`);
  }

  /**
   * Picks the lowest free port pair in the configured range.
   *
   * Checks all three instance columns, not just this feature's own: one
   * project can carry a provisioned instance (`provisioning_port`), an
   * ADR-067 restored copy (`restored_port`) and this one at the same time, and
   * a collision between any two of them would have two units fighting over one
   * socket. Re-implemented here rather than shared with the restore service
   * because each is private and reads a different column.
   */
  private async allocatePort(): Promise<number | null> {
    const { portRangeStart, portRangeEnd } = this.config.provisioning!;

    const [provisioned, restored, connected] = await Promise.all([
      this.database.db.select({ port: projects.provisioningPort }).from(projects),
      this.database.db.select({ port: projects.restoredPort }).from(projects),
      this.database.db.select({ port: projects.connectedInstancePort }).from(projects),
    ]);
    const taken = new Set(
      [...provisioned, ...restored, ...connected]
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
 * Derives a stable systemd/database-safe name for this project's own instance.
 *
 * Suffixed `-i-` (instance) rather than `-r-` (ADR-067's restored copy): a
 * project may have both at once, and if the two ever produced the same string
 * one script's project-directory guard would reject the other's. The project's
 * own technical name is never reused either, for the same reason.
 */
export function deriveInstanceName(projectName: string, projectId: string): string {
  const slug = projectName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 20);
  const suffix = projectId.replace(/-/g, '').slice(0, 8);
  const base = slug || 'connected';
  return `${base}-i-${suffix}`;
}

/**
 * The master password line `create_project` prints, same marker
 * `ProjectProvisioningService.parseMasterPassword` reads.
 */
export function parseMasterPassword(stdout: string): string | null {
  const marker = /Odoo Master Password:\s*\n+\s*(\S+)/;
  const match = marker.exec(stdout);
  return match ? match[1] : null;
}

function summariseTail(output: string, maxLines = 15): string {
  const lines = output.trim().split('\n');
  return lines.slice(-maxLines).join('\n').slice(0, 2000);
}
