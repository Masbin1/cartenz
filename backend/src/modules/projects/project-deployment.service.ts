import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { CommandRunner } from '../../core/process/command-runner.service';
import { DatabaseService } from '../../core/database/database.service';
import { projectConnections, projects } from '../../core/database/schema';
import { APP_CONFIG } from '../../core/config/config.module';
import type { AppConfig } from '../../core/config/configuration';
import { SECRETS_PROVIDER, type SecretsProvider } from '../../core/secrets/secrets.provider';
import { GIT_CONNECTION_TYPES } from '../../core/enums';
import { AuditService } from '../../core/audit/audit.service';
import { AUDIT_EVENTS } from '../../core/audit/audit-events';

/**
 * Brings a project's on-premise instance up to date with its own repository
 * (ADR-049).
 *
 * This closes the gap ADR-041 left behind. That ADR gives a created project a
 * GitHub repository and reaches it — the platform can push to the project's
 * branch — but every part of the platform reads the *instance* directory only at
 * the moment it is written: `create_project` lays down an empty scaffold, the
 * agent commits into it, the platform pushes. Nothing ever pulled. A commit
 * pushed by a developer (or by an earlier task) never reached the running Odoo,
 * so the instance drifted from the branch it claims to serve.
 *
 * The pull itself happens in a root-run script
 * (`infrastructure/provisioning/pull-project.sh`) rather than here, for the
 * reason every provisioning step does: `/opt/odoo/projects/<name>/` is
 * `odoo:odoo` mode 750, and the `cartenz` user this platform runs as cannot
 * write into it at all. CommandRunner refuses the invocation unless
 * `PROJECT_PROVISIONING_ENABLED` is true and the script path is the one
 * configured, exactly as it does for `create_project` and the HTTPS script.
 */
export interface PullProjectResult {
  readonly ok: boolean;
  /** The commit the instance now sits on, when the pull succeeded. */
  readonly commit: string | null;
  readonly branch: string | null;
  /** The script's own summary line, or the reason it refused. */
  readonly message: string;
  readonly durationMs: number;
}

@Injectable()
export class ProjectDeploymentService {
  private readonly logger = new Logger(ProjectDeploymentService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly commands: CommandRunner,
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    @Inject(SECRETS_PROVIDER) private readonly secrets: SecretsProvider,
  ) {}

  /**
   * Whether this deployment can pull at all.
   *
   * Both halves matter and neither implies the other: the feature is off when
   * `PROJECT_PULL_SCRIPT` is unset (the operator has not installed the script or
   * its sudoers entry), and off when provisioning is disabled at the process
   * layer, because the pull goes through the same `sudo` grant. Reported to the
   * portal so a Deploy button is never offered on a deployment where every press
   * would be refused — the failure mode ADR-040's HTTPS toggle was written to
   * avoid.
   */
  get available(): boolean {
    return Boolean(this.config.provisioning?.enabled && this.config.provisioning.pullScript);
  }

  async pull(projectId: string, userId: string): Promise<PullProjectResult> {
    const startedAt = Date.now();

    if (!this.available) {
      return {
        ok: false,
        commit: null,
        branch: null,
        message:
          'Pulling is not configured on this deployment. PROJECT_PULL_SCRIPT is empty, or ' +
          'PROJECT_PROVISIONING_ENABLED is false.',
        durationMs: 0,
      };
    }

    const [project] = await this.database.db
      .select({
        id: projects.id,
        name: projects.name,
        repositoryUrl: projects.repositoryUrl,
        defaultBranch: projects.defaultBranch,
        environmentConfig: projects.environmentConfig,
      })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    if (!project) {
      return this.refuse(projectId, userId, 'Project not found.', startedAt);
    }

    if (!project.repositoryUrl) {
      return this.refuse(
        projectId,
        userId,
        'This project has no repository, so there is nothing to pull. Connect one first.',
        startedAt,
      );
    }

    // Derived from the on-premise path rather than stored separately, because
    // the two cannot be allowed to disagree: the script acts on
    // /opt/odoo/projects/<technicalName>, and the on-premise path is
    // <that directory>/addons (ADR-039). Taking the parent's basename means a
    // project whose row was written by any code path still resolves to the
    // directory that actually exists.
    const technicalName = this.technicalNameFrom(project.environmentConfig);

    if (!technicalName) {
      return this.refuse(
        projectId,
        userId,
        'This project is not provisioned on this host, so there is no instance directory to ' +
          'pull into. Provision it first.',
        startedAt,
      );
    }

    const credential = await this.gitCredential(projectId);
    const branch = project.defaultBranch;

    this.logger.log(
      `Pulling "${technicalName}" from ${project.repositoryUrl} (${branch}) via ` +
        `${this.config.provisioning?.pullScript}`,
    );

    try {
      const result = await this.commands.run(
        'sudo',
        ['-n', this.config.provisioning!.pullScript!, technicalName, project.repositoryUrl, branch],
        {
          cwd: '/',
          timeoutMs: this.config.process.maxTimeoutMs,
          // The credential travels on stdin, never in argv: /proc/<pid>/cmdline
          // is world-readable on this host, and a token in it would be readable
          // by every user on the machine for as long as the fetch lasts.
          ...(credential ? { stdin: credential } : {}),
        },
      );

      const durationMs = Date.now() - startedAt;

      if (result.exitCode !== 0) {
        const detail = summariseTail(result.stderr || result.stdout);
        await this.audit.record({
          event: AUDIT_EVENTS.PROJECT_PULL_FAILED,
          projectId,
          userId,
          metadata: { branch, repositoryUrl: project.repositoryUrl, error: detail },
        });
        this.logger.error(`Pull of "${technicalName}" failed: ${detail}`);
        return {
          ok: false,
          commit: null,
          branch,
          message: detail || `The pull script exited with code ${result.exitCode}.`,
          durationMs,
        };
      }

      // The script prints `OK: <name> addons/ is now at <branch> @ <sha>`; the
      // commit is read back from its output rather than from `git rev-parse`
      // here, because this process cannot read the directory the script just
      // wrote to (it is odoo:odoo and cartenz has no read access to it).
      const commit = /@\s([0-9a-f]{7,40})\s*$/.exec(result.stdout.trim())?.[1] ?? null;

      await this.audit.record({
        event: AUDIT_EVENTS.PROJECT_PULLED,
        projectId,
        userId,
        metadata: { branch, commit, repositoryUrl: project.repositoryUrl },
      });

      return {
        ok: true,
        commit,
        branch,
        message:
          summariseTail(result.stdout) ||
          `${technicalName} is now at ${branch}${commit ? ` @ ${commit}` : ''}.`,
        durationMs,
      };
    } catch (error) {
      return this.refuse(projectId, userId, (error as Error).message, startedAt);
    }
  }

  /**
   * The oldest connection that can supply a git credential (ADR-041).
   *
   * The same selection the task layer makes, and for the same reason recorded
   * there: a project may hold an `odoo_api` key as well as a repository, and
   * presenting an Odoo API key to a Git host is a leaked-credential incident
   * waiting to happen. A public repository legitimately has none, which is why
   * an absent credential is not an error.
   */
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
      // A connection whose secret cannot be opened is not the same as no
      // connection: say so, because the pull will fail at the remote with an
      // authentication error that reads like a wrong URL.
      this.logger.warn(
        `Could not read the git credential for project ${projectId}: ${(error as Error).message}`,
      );
      return null;
    }
  }

  private technicalNameFrom(environmentConfig: Record<string, unknown>): string | null {
    const onPremisePath = environmentConfig?.onPremisePath;
    if (typeof onPremisePath !== 'string' || onPremisePath.length === 0) return null;

    // <projectsDir>/<technicalName>/addons
    const parts = onPremisePath.replace(/\/+$/, '').split('/');
    const candidate = parts[parts.length - 2] ?? '';

    return /^[a-z0-9][a-z0-9_-]{1,30}$/.test(candidate) ? candidate : null;
  }

  private async refuse(
    projectId: string,
    userId: string,
    message: string,
    startedAt: number,
  ): Promise<PullProjectResult> {
    await this.audit.record({
      event: AUDIT_EVENTS.PROJECT_PULL_FAILED,
      projectId,
      userId,
      metadata: { error: message },
    });

    return { ok: false, commit: null, branch: null, message, durationMs: Date.now() - startedAt };
  }
}

/**
 * The last non-empty line of a script's output, bounded.
 *
 * The scripts are chatty and the interesting line is the last one — either
 * `OK: …` or the error that stopped it. Bounding it keeps a stack trace out of
 * the portal and out of the audit row.
 */
function summariseTail(value: string): string {
  const lines = value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return (lines[lines.length - 1] ?? '').slice(0, 400);
}
