import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { CommandRunner } from '../../core/process/command-runner.service';
import { DatabaseService } from '../../core/database/database.service';
import { projectConnections, projects } from '../../core/database/schema';
import { APP_CONFIG } from '../../core/config/config.module';
import type { AppConfig } from '../../core/config/configuration';
import { SECRETS_PROVIDER, type SecretsProvider } from '../../core/secrets/secrets.provider';
import { GIT_CONNECTION_TYPES } from '../../core/enums';
import { effectiveRepositoryUrl } from './repository-url';
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

/**
 * ADR-057: what an upgrade-and-restart attempt produced.
 *
 * `rolledBack` is its own field rather than something a reader has to infer from
 * the message: it is the difference between "your deploy did not land and the
 * instance is on the code it was serving before" and "your deploy did not land
 * and the instance may be half-upgraded". The first needs a retry, the second
 * needs an operator.
 */
export interface RestartProjectResult {
  readonly ok: boolean;
  /** The commit the instance is serving afterwards — old or new. */
  readonly commit: string | null;
  readonly branch: string | null;
  /** True when the upgrade failed and the code was put back as it was. */
  readonly rolledBack: boolean;
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

  /**
   * Whether this deployment can restart at all (ADR-057).
   *
   * Its own script, its own flag: `restartScript` is empty until an operator has
   * installed `restart-project.sh` and its dedicated sudoers entry, exactly the
   * two-part gate `pull`'s own `available` already checks for its script.
   */
  get restartAvailable(): boolean {
    return Boolean(this.config.provisioning?.enabled && this.config.provisioning.restartScript);
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

    // ADR-041's lesson: a project the platform created a repository for holds it
    // as a connection, and its own column stays null on purpose (the connection
    // carries the credential). Reading only the column refused those projects —
    // which is the common case for a project created through the portal.
    const repositoryUrl = await this.resolveRepositoryUrl(projectId, project.repositoryUrl);

    if (!repositoryUrl) {
      return this.refuse(
        projectId,
        userId,
        'This project has no repository, so there is nothing to pull. Connect one first.',
        startedAt,
      );
    }

    // Resolved from the project's recorded on-premise path and anchored to the
    // configured projects root — not by taking a parent's basename, which put the
    // scaffolded (root) form of that path on the wrong directory. See the function.
    const technicalName = technicalNameFromOnPremisePath(
      project.environmentConfig,
      this.config.provisioning?.projectsDir ?? '',
    );

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
      `Pulling "${technicalName}" from ${repositoryUrl} (${branch}) via ` +
        `${this.config.provisioning?.pullScript}`,
    );

    try {
      const result = await this.commands.run(
        'sudo',
        ['-n', this.config.provisioning!.pullScript!, technicalName, repositoryUrl, branch],
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
          metadata: { branch, repositoryUrl, error: detail },
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
        metadata: { branch, commit, repositoryUrl },
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
   * ADR-057: bring an instance onto a branch's tip *and serve it* — pull, apply
   * every installed module's upgrade, bounce the unit.
   *
   * The half `pull` does not do. Pulling resets `addons/` on disk; a new field, a
   * changed view or a migration is invisible until Odoo runs `-u` against the
   * instance's database, and new Python is not loaded until the unit restarts.
   * Doing only the pull is how a project ends up claiming to serve a commit whose
   * schema it never applied.
   *
   * Asynchronous by design (ADR-057 §3): this method is the *worker's* entry
   * point, reached through the provisioning queue because `-u all` can run past
   * `PROCESS_MAX_TIMEOUT_MS`. It is not on an HTTP request thread, so it reports
   * by writing the outcome onto the project row rather than by returning to a
   * caller — the same division `completeSelectiveProvisioning` makes.
   *
   * The branch is a parameter, never implied from `defaultBranch`: restarting a
   * staging instance onto `staging` is as legitimate a call as promoting onto
   * `main`, and the caller states which it means.
   */
  async restart(
    projectId: string,
    technicalName: string,
    repositoryUrl: string,
    branch: string,
    userId: string,
  ): Promise<RestartProjectResult> {
    const startedAt = Date.now();

    if (!this.restartAvailable) {
      return {
        ok: false,
        commit: null,
        branch,
        rolledBack: false,
        message:
          'Restarting is not configured on this deployment. PROJECT_RESTART_SCRIPT is empty, ' +
          'or PROJECT_PROVISIONING_ENABLED is false.',
        durationMs: 0,
      };
    }

    const credential = await this.gitCredential(projectId);

    this.logger.log(
      `Restarting "${technicalName}" from ${repositoryUrl} (${branch}) via ` +
        `${this.config.provisioning?.restartScript}`,
    );

    try {
      const result = await this.commands.run(
        'sudo',
        ['-n', this.config.provisioning!.restartScript!, technicalName, repositoryUrl, branch],
        {
          cwd: '/',
          timeoutMs: this.config.process.maxTimeoutMs,
          // The credential travels on stdin, never in argv — the same reason the
          // pull passes it that way.
          ...(credential ? { stdin: credential } : {}),
        },
      );

      const durationMs = Date.now() - startedAt;
      const output = result.stdout.trim();

      if (result.exitCode !== 0) {
        // The script distinguishes the two failure shapes itself: it prints
        // `ROLLEDBACK: <commit>` on the line before the error when it put the
        // code back, and says nothing of the sort when the instance may be
        // half-upgraded. Read rather than guessed, because the whole point of
        // that flag is that a caller cannot infer it.
        const rolledBack = /^ROLLEDBACK:/m.test(output);
        const previousCommit = /^ROLLEDBACK:\s*([0-9a-f]{7,40})/m.exec(output)?.[1] ?? null;
        const detail = summariseTail(result.stderr || result.stdout);

        await this.audit.record({
          event: AUDIT_EVENTS.PROJECT_RESTART_FAILED,
          projectId,
          userId,
          metadata: {
            branch,
            repositoryUrl,
            rolledBack,
            commit: previousCommit,
            error: detail,
          },
        });

        this.logger.error(
          `Restart of "${technicalName}" failed${rolledBack ? ' (rolled back)' : ''}: ${detail}`,
        );

        return {
          ok: false,
          commit: previousCommit,
          branch,
          rolledBack,
          message: detail || `The restart script exited with code ${result.exitCode}.`,
          durationMs,
        };
      }

      // `OK: <name> is now serving <branch> @ <sha>` — the commit is read back
      // from the script's output rather than from `git rev-parse` here, for the
      // same reason the pull does: this process cannot read the instance
      // directory the script just wrote to.
      const commit = /@\s([0-9a-f]{7,40})\s*$/.exec(output)?.[1] ?? null;

      await this.audit.record({
        event: AUDIT_EVENTS.PROJECT_RESTARTED,
        projectId,
        userId,
        metadata: { branch, commit, repositoryUrl },
      });

      return {
        ok: true,
        commit,
        branch,
        rolledBack: false,
        message:
          summariseTail(output) ||
          `${technicalName} is now serving ${branch}${commit ? ` @ ${commit}` : ''}.`,
        durationMs,
      };
    } catch (error) {
      return {
        ok: false,
        commit: null,
        branch,
        rolledBack: false,
        message: (error as Error).message,
        durationMs: Date.now() - startedAt,
      };
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

  /**
   * Where this project's repository actually is (ADR-041's lesson).
   *
   * `projects.repository_url` is one of the two places a repository can be
   * recorded, and not the common one: a project the platform created a
   * repository for holds it as a connection, with its own column left null on
   * purpose because the connection carries the credential. Reading only the
   * column hid Deploy — and now Ship to production — on exactly the projects
   * that have a repository.
   */
  private async resolveRepositoryUrl(
    projectId: string,
    projectUrl: string | null,
  ): Promise<string | null> {
    const connections = await this.database.db
      .select({
        connectionType: projectConnections.connectionType,
        metadata: projectConnections.metadata,
      })
      .from(projectConnections)
      .where(eq(projectConnections.projectId, projectId));

    return effectiveRepositoryUrl(projectUrl, connections);
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
 * The project directory name the pull script acts on, from a project's stored
 * on-premise path.
 *
 * `pull-project.sh` acts on `<projectsDir>/<technicalName>`, while a project
 * records an on-premise path that is *inside* that directory — `<name>/addons`
 * for a provisioned project (ADR-039), and `<name>` itself for a scaffolded one
 * (ADR-032). This resolves either form to the name, and it is the one value
 * that decides which directory a root-run script is pointed at, so it is
 * anchored rather than guessed at:
 *
 *  - the path must sit under the configured projects root, so a row pointing at
 *    `/tmp/ggroma/addons` resolves to nothing and the pull is refused;
 *  - exactly one path segment may follow the root, so `/…/projects/addons`
 *    cannot resolve to a project called `addons`;
 *  - that segment must be a plain directory name, so `..` and uppercase and
 *    anything else the scripts' own validation would reject is refused too.
 *
 * An earlier version took the basename's parent — which put `/…/projects/ggroma`
 * and `/…/projects/../etc/addons` on the wrong directory. The tests below are
 * what caught that; it is not a shape to re-derive by eye.
 */
export function technicalNameFromOnPremisePath(
  environmentConfig: Record<string, unknown> | null,
  projectsDir: string,
): string | null {
  const onPremisePath = environmentConfig?.onPremisePath;
  if (typeof onPremisePath !== 'string' || onPremisePath.length === 0) return null;

  const root = projectsDir.replace(/\/+$/, '');
  if (!root.startsWith('/')) return null;

  let path = onPremisePath.replace(/\/+$/, '');
  if (path.endsWith('/addons')) path = path.slice(0, -'/addons'.length);
  path = path.replace(/\/+$/, '');

  const prefix = `${root}/`;
  if (!path.startsWith(prefix)) return null;

  const name = path.slice(prefix.length);
  if (name.includes('/')) return null;

  return /^[a-z0-9][a-z0-9_-]{1,30}$/.test(name) ? name : null;
}

/**
 * The last non-empty line of a script's output, bounded.
 *
 * The scripts are chatty and the interesting line is the last one — either
 * `OK: …` or the error that stopped it. Bounding it keeps a stack trace out of
 * the portal and out of the audit row.
 */
export function summariseTail(value: string): string {
  const lines = value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return (lines[lines.length - 1] ?? '').slice(0, 400);
}
