import { Inject, Injectable, Logger } from '@nestjs/common';
import { createConnection } from 'node:net';
import { and, gte, lte } from 'drizzle-orm';
import { CommandRunner } from '../../core/process/command-runner.service';
import { DatabaseService } from '../../core/database/database.service';
import { projects } from '../../core/database/schema';
import { APP_CONFIG } from '../../core/config/config.module';
import type { AppConfig } from '../../core/config/configuration';
import type { OdooEdition } from '../../core/enums';

/**
 * Turns a scaffolded "Create with AI" / on-premise project directory into a
 * real, running Odoo instance (ADR-039), by running the operator's own
 * create_project / create_project_enterprise scripts as root through sudo.
 *
 * This class does not create a directory, a database, a systemd service or an
 * Nginx vhost itself. Those scripts do, on the host, outside this process. This
 * class only:
 *
 *  1. Picks a port nothing else on this platform has already claimed.
 *  2. Invokes the correct script through CommandRunner, which is the platform's
 *     one process chokepoint (ADR-019) and independently refuses the call
 *     unless PROJECT_PROVISIONING_ENABLED is true (ADR-039, mirroring
 *     GIT_PUSH_ENABLED and VALIDATION_ENABLED).
 *  3. Reports what happened, in the shape ProjectsService writes onto the
 *     project row.
 *
 * `create_project`/`create_project_enterprise` themselves create the project
 * directory with `mkdir` and `chown odoo:odoo` — they refuse to run against a
 * directory that already exists. That is why ProjectsService no longer
 * scaffolds a directory before calling this service for a project that is
 * being provisioned for real: the two would race to create the same path
 * under different owners. See ADR-039 for the full account of that
 * conflict and why the operator's script is the one that wins it.
 */
export interface ProvisionProjectInput {
  readonly organizationId: string;
  readonly projectId: string;
  /**
   * The exact directory/database name the scripts will use. Must already
   * satisfy the scripts' own validation
   * (`^[a-z0-9][a-z0-9_-]{1,30}$`) — ProjectsService derives it the same way
   * it derives a scaffold's technicalName, so the two stay in sync.
   */
  readonly technicalName: string;
  readonly odooEdition: OdooEdition;
}

export interface ProvisionProjectResult {
  readonly provisioned: boolean;
  readonly port: number | null;
  readonly url: string | null;
  /** The plaintext Odoo master password create_project printed, or null. Never
   * logged, never returned to a caller beyond this module: ProjectsService
   * seals it through SecretsProvider immediately and discards the plaintext.
   */
  readonly masterPassword: string | null;
  readonly databaseName: string | null;
  readonly error: string | null;
  readonly stdout: string;
  readonly stderr: string;
  /** HTTPS issuance outcome (ADR-040), only meaningful when provisioned is true. */
  readonly https: {
    readonly status: 'none' | 'pending' | 'issued' | 'failed';
    readonly error: string | null;
  };
}

@Injectable()
export class ProjectProvisioningService {
  private readonly logger = new Logger(ProjectProvisioningService.name);

  constructor(
    private readonly commands: CommandRunner,
    private readonly database: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** True when this deployment is configured to provision real instances. */
  get available(): boolean {
    return this.config.provisioning.enabled;
  }

  /**
   * Allocates a port and runs the provisioning script. Never throws for a
   * script failure or a disabled deployment — both come back as a result the
   * caller writes onto the project row, because a provisioning failure is not
   * a reason to fail project creation: the scaffold and the specification
   * already exist and are useful on their own.
   */
  async provision(input: ProvisionProjectInput): Promise<ProvisionProjectResult> {
    const noHttps = { status: 'none' as const, error: null };

    if (!this.available) {
      return {
        provisioned: false,
        port: null,
        url: null,
        masterPassword: null,
        databaseName: null,
        error:
          'Project provisioning is not enabled on this server ' +
          '(PROJECT_PROVISIONING_ENABLED=false). The project was created but has no running ' +
          'Odoo instance; an operator can provision it manually on the host.',
        stdout: '',
        stderr: '',
        https: noHttps,
      };
    }

    const port = await this.allocatePort();
    if (port === null) {
      return {
        provisioned: false,
        port: null,
        url: null,
        masterPassword: null,
        databaseName: null,
        error:
          `No free port was found in the configured range ` +
          `${this.config.provisioning.portRangeStart}-${this.config.provisioning.portRangeEnd}. ` +
          'Widen PROJECT_PORT_RANGE_START/END, or provision this project manually.',
        stdout: '',
        stderr: '',
        https: noHttps,
      };
    }

    const script =
      input.odooEdition === 'enterprise'
        ? this.config.provisioning.enterpriseScript
        : this.config.provisioning.communityScript;

    this.logger.log(
      `Provisioning "${input.technicalName}" (${input.odooEdition}) on port ${port} via ${script}`,
    );

    try {
      const result = await this.commands.run('sudo', ['-n', script, input.technicalName, String(port)], {
        cwd: '/',
        // The scripts install a database (`-i base`) and start a systemd unit;
        // slower than a git command by a wide margin, and the default process
        // timeout would kill it mid-run.
        timeoutMs: this.config.process.maxTimeoutMs,
      });

      if (result.exitCode !== 0) {
        this.logger.error(
          `Provisioning "${input.technicalName}" failed (exit ${result.exitCode}): ` +
            summariseTail(result.stderr || result.stdout),
        );
        return {
          provisioned: false,
          port: null,
          url: null,
          masterPassword: null,
          databaseName: null,
          error: summariseTail(result.stderr || result.stdout) || `exit code ${result.exitCode}`,
          stdout: result.stdout,
          stderr: result.stderr,
          https: noHttps,
        };
      }

      // create_project/create_project_enterprise chown the whole project
      // directory to odoo:odoo, mode 750, which leaves addons/ unwritable by
      // this platform's own user. Run the narrow fix-up before reporting
      // success: a project that is "provisioned" but whose addons/ the agent
      // cannot write to would fail at the first task instead of here, with a
      // much less specific error.
      const grant = await this.commands
        .run('sudo', ['-n', this.config.provisioning.grantScript, input.technicalName], {
          cwd: '/',
          timeoutMs: this.config.process.timeoutMs,
        })
        .catch((error: Error) => ({ exitCode: 1, stdout: '', stderr: error.message, durationMs: 0, timedOut: false, truncated: false }));

      if (grant.exitCode !== 0) {
        this.logger.error(
          `Provisioned "${input.technicalName}" but could not grant addons/ write access: ` +
            summariseTail(grant.stderr || grant.stdout),
        );
        return {
          provisioned: false,
          port: null,
          url: null,
          masterPassword: null,
          databaseName: null,
          error:
            `The Odoo instance was provisioned on port ${port}, but addons/ could not be ` +
            `made writable for the platform: ${summariseTail(grant.stderr || grant.stdout)}. ` +
            'The agent cannot write code into this project until an operator runs ' +
            `${this.config.provisioning.grantScript} ${input.technicalName} manually.`,
          stdout: result.stdout,
          stderr: `${result.stderr}\n${grant.stderr}`.trim(),
          https: noHttps,
        };
      }

      // The master password create_project/create_project_enterprise printed
      // to stdout on success (ADR-040). Parsed once, here, and never logged:
      // the caller (ProjectsService) seals it through SecretsProvider
      // immediately and this value is not retained past that call.
      const masterPassword = parseMasterPassword(result.stdout);
      if (!masterPassword) {
        this.logger.warn(
          `Provisioned "${input.technicalName}" but could not find the master password in the ` +
            "script's output. The instance is running; the password is recoverable only from " +
            `${this.config.provisioning.projectsDir}/${input.technicalName}/config/odoo.conf on the host.`,
        );
      }

      const httpUrl = `http://${input.technicalName}.${this.config.provisioning.baseDomain}`;
      const loopbackUrl = `http://127.0.0.1:${port}`;
      let url = this.config.provisioning.baseDomain ? httpUrl : loopbackUrl;
      let https: ProvisionProjectResult['https'] = noHttps;

      // HTTPS issuance (ADR-040): only attempted when a real domain is
      // configured and the deployment has opted in. A failure here does not
      // fail provisioning — the instance is real and running over HTTP either
      // way — it is reported alongside the result for the portal to show.
      if (this.httpsAvailable && this.config.provisioning.baseDomain) {
        const domain = `${input.technicalName}.${this.config.provisioning.baseDomain}`;
        https = await this.issueHttps(input.technicalName, domain);
        if (https.status === 'issued') {
          url = `https://${domain}`;
        }
      }

      this.logger.log(`Provisioned "${input.technicalName}" at ${url} (port ${port})`);

      return {
        provisioned: true,
        port,
        url,
        masterPassword,
        databaseName: input.technicalName,
        error: null,
        stdout: result.stdout,
        stderr: result.stderr,
        https,
      };
    } catch (error) {
      // CommandRunner itself refuses the call (disabled, malformed invocation).
      // Reached only if the setting flips between the `available` check above
      // and the call below, or another guard trips — kept as a result rather
      // than an exception for the same reason as every other branch here.
      const message = (error as Error).message;
      this.logger.error(`Provisioning "${input.technicalName}" was refused: ${message}`);
      return {
        provisioned: false,
        port: null,
        url: null,
        masterPassword: null,
        databaseName: null,
        error: message,
        stdout: '',
        stderr: '',
        https: noHttps,
      };
    }
  }

  /** True when this deployment is configured to issue HTTPS certificates. */
  private get httpsAvailable(): boolean {
    return this.config.https?.enabled === true && !!this.config.https.email;
  }

  /**
   * Runs the HTTPS-issuance script for a freshly provisioned project (ADR-040).
   *
   * Never throws: a certificate that could not be issued leaves the instance
   * reachable over plain HTTP, which is a degraded result, not a failed one.
   */
  private async issueHttps(
    technicalName: string,
    domain: string,
  ): Promise<ProvisionProjectResult['https']> {
    const email = this.config.https.email;
    if (!email) return { status: 'none', error: null };

    this.logger.log(`Requesting HTTPS for "${technicalName}" (${domain})`);

    try {
      const result = await this.commands.run(
        'sudo',
        ['-n', this.config.https.script, technicalName, domain, email],
        { cwd: '/', timeoutMs: this.config.process.maxTimeoutMs },
      );

      if (result.exitCode !== 0) {
        const message = summariseTail(result.stderr || result.stdout) || `exit code ${result.exitCode}`;
        this.logger.error(`HTTPS issuance for "${technicalName}" failed: ${message}`);
        return { status: 'failed', error: message };
      }

      this.logger.log(`HTTPS issued for "${technicalName}" (${domain})`);
      return { status: 'issued', error: null };
    } catch (error) {
      const message = (error as Error).message;
      this.logger.error(`HTTPS issuance for "${technicalName}" was refused: ${message}`);
      return { status: 'failed', error: message };
    }
  }

  /**
   * Picks the lowest free HTTP port in the configured range.
   *
   * "Free" means: not already recorded against another project in this
   * platform's own database, and not currently listening on this host. The
   * database check is what makes allocation race-safe across concurrent
   * requests to the extent the database's own read-then-write can be; the
   * live check catches a port used by something the database does not know
   * about (a manually created project, a leftover service). Each project
   * takes two ports (HTTP, then HTTP+1 for gevent/websocket, exactly as
   * create_project derives it) so both are checked and only the HTTP port is
   * stored — the gevent port is never independently allocated.
   */
  private async allocatePort(): Promise<number | null> {
    const { portRangeStart, portRangeEnd } = this.config.provisioning;

    const taken = await this.database.db
      .select({ port: projects.provisioningPort })
      .from(projects)
      .where(
        and(
          gte(projects.provisioningPort, portRangeStart),
          lte(projects.provisioningPort, portRangeEnd),
        ),
      );
    const takenPorts = new Set(taken.map((row) => row.port).filter((port): port is number => port !== null));

    for (let port = portRangeStart; port + 1 <= portRangeEnd; port += 2) {
      if (takenPorts.has(port) || takenPorts.has(port + 1)) continue;
      if ((await this.isPortFree(port)) && (await this.isPortFree(port + 1))) return port;
    }

    return null;
  }

  /** True when nothing on this host is already listening on the given port. */
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
}

/** The last few lines of a script's output, for a message a person can act on. */
function summariseTail(output: string, maxLines = 15): string {
  const lines = output.trim().split('\n');
  return lines.slice(-maxLines).join('\n');
}

/**
 * Extracts the Odoo master password from create_project's stdout (ADR-040).
 *
 * The script prints a fixed block:
 *
 *   Odoo Master Password:
 *
 *     <password>
 *
 * Parsed defensively — a future edit to the script's wording should degrade to
 * "no password found" (logged, not thrown) rather than silently capturing the
 * wrong line, since whatever this returns is sealed as a real credential.
 */
function parseMasterPassword(stdout: string): string | null {
  const marker = /Odoo Master Password:\s*\n+\s*(\S+)/;
  const match = marker.exec(stdout);
  return match ? match[1] : null;
}
