import { Inject, Injectable, Logger } from '@nestjs/common';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { APP_CONFIG } from '../../core/config/config.module';
import type { AppConfig } from '../../core/config/configuration';
import { DatabaseService } from '../../core/database/database.service';
import { projects } from '../../core/database/schema';
import { SECRETS_PROVIDER, type SecretsProvider } from '../../core/secrets/secrets.provider';
import { AuditService } from '../../core/audit/audit.service';
import { AUDIT_EVENTS } from '../../core/audit/audit-events';
import { GitService, GitPullRefusedError } from '../../agent/git/git.service';
import type { GitCredential } from '../../agent/git/git-credentials';
import { resolveProjectGitAccess } from '../../agent/git/project-git-access';
import { OdooProjectAnalyser } from '../../agent/analysis/odoo-project-analyser';
import { ProjectMemoryService } from '../../agent/analysis/project-memory.service';
import { GitCredentialsService } from '../settings/git-credentials.service';
import { projectEnvironments } from '../../core/database/schema';

/** What one branch's checkout on disk looks like. */
export interface CheckoutBranchState {
  readonly branch: string;
  /** Absolute path of the clone, or the path it would occupy. */
  readonly path: string;
  readonly exists: boolean;
  /** The commit the checkout is at. Null when there is no checkout yet. */
  readonly commit: string | null;
  /**
   * The remote's tip as of the last fetch, not as of now.
   *
   * Deliberately read from the local remote-tracking ref rather than by
   * contacting the remote: a project page must not open an SSH connection to
   * GitHub every time somebody looks at it. `POST .../checkout/sync` is what
   * contacts the remote, and the difference between this and the truth is
   * exactly what that action exists to close.
   */
  readonly remoteCommit: string | null;
  /** Commits this checkout is behind the remote, as of the last fetch. */
  readonly behind: number | null;
  /** Uncommitted local changes. A checkout nobody edits should never have any. */
  readonly dirty: boolean;
  /** Total commits reachable from HEAD - proves the clone is not shallow. */
  readonly historyDepth: number | null;
  readonly lastSyncedAt: string | null;
}

export interface ProjectCheckoutStatus {
  /** False when this deployment has no PROJECT_CHECKOUT_ROOT. */
  readonly enabled: boolean;
  readonly reason: string | null;
  readonly root: string | null;
  readonly branches: readonly CheckoutBranchState[];
}

export interface ProjectCheckoutSyncResult {
  readonly branch: string;
  readonly outcome:
    | 'cloned'
    | 'up_to_date'
    | 'fast_forwarded'
    | 'refused'
    | 'failed';
  readonly commit: string | null;
  readonly behind: number | null;
  /** Commits in the checkout's history after the sync. */
  readonly historyDepth: number | null;
  /** Modules the refreshed analysis found, when it ran. */
  readonly modules: number | null;
  /** What happened, in a sentence a person can read. */
  readonly message: string;
  readonly durationMs: number;
}

/** The state file written beside each checkout. */
interface CheckoutState {
  readonly branch: string;
  readonly lastSyncedAt: string;
  readonly commit: string | null;
}

/**
 * One clone per project, kept between tasks (ADR-063).
 *
 * Why this exists: a task clones the repository into a workspace that is deleted
 * when the task ends, so the only time this platform holds a project's source is
 * while a task is running. Two consequences followed. Reading a project - what
 * modules it has, how the code came to look the way it does - was only possible
 * by submitting a task and waiting, so the portal's view of a project was
 * whatever the last task happened to analyse, which is how a branch updated at
 * 13:47 could look unchanged at 15:00. And every task re-downloaded the whole
 * repository, because a workspace has nothing to reuse.
 *
 * This gives a connected project a clone that outlives its tasks, per branch,
 * under `PROJECT_CHECKOUT_ROOT`. Git history is full rather than shallow
 * (`GIT_CLONE_DEPTH` governs task clones; a checkout exists to be read, and one
 * commit of history is not readable). Syncing is explicit - a person pressing a
 * button - rather than a background timer, because a directory that refreshes
 * itself is still a source of truth that can disagree with the remote, and the
 * disagreement is easier to trust when a person asked for the refresh and can
 * see when it happened.
 *
 * What this deliberately is not: a second source of truth that tasks write
 * through. A task still gets its own workspace and still pushes to the remote,
 * which remains the only shared state (ADR-041). This directory is a read model,
 * and `PROJECT_CHECKOUT_REUSE` is the switch that would make it more than that.
 *
 * Nothing here is `sudo`-gated, because unlike a provisioned instance this
 * directory is owned by the platform user: it lives under the platform's own
 * runtime root, not under `/opt/odoo/projects`, which is `odoo:odoo` mode 750.
 */
@Injectable()
export class ProjectCheckoutService {
  private readonly logger = new Logger(ProjectCheckoutService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly database: DatabaseService,
    private readonly git: GitService,
    private readonly gitCredentials: GitCredentialsService,
    @Inject(SECRETS_PROVIDER) private readonly secrets: SecretsProvider,
    private readonly audit: AuditService,
    private readonly analyser: OdooProjectAnalyser,
    private readonly memory: ProjectMemoryService,
  ) {}

  /** True when this deployment has a checkout root configured. */
  get enabled(): boolean {
    return this.config.checkouts?.root !== null && this.config.checkouts?.root !== undefined;
  }

  /**
   * What is on disk for this project, read without touching the network.
   *
   * Every branch the project works on - its default branch and each
   * environment's - is reported whether or not it has been cloned, so the page
   * can offer to create the missing one rather than showing it as absent with no
   * way to ask for it.
   */
  async status(projectId: string): Promise<ProjectCheckoutStatus> {
    if (!this.enabled) {
      return {
        enabled: false,
        reason:
          'Keeping a local clone of each project is not enabled on this deployment. Set PROJECT_CHECKOUT_ROOT to turn it on.',
        root: null,
        branches: [],
      };
    }

    const project = await this.projectRow(projectId);
    const access = await this.access(projectId);

    /**
     * With no repository there is nothing to list: showing branch names that
     * cannot be cloned invites someone to press Sync on a branch that will be
     * refused. The reason is the whole answer.
     */
    if (!access.repositoryUrl) {
      return {
        enabled: true,
        reason: 'This project has no repository connected, so there is nothing to clone.',
        root: this.config.checkouts.root,
        branches: [],
      };
    }

    const branches = await this.branchesFor(projectId, project.defaultBranch);

    return {
      enabled: true,
      reason: null,
      root: this.config.checkouts.root,
      branches: await Promise.all(
        branches.map((branch) => this.branchState(projectId, branch)),
      ),
    };
  }

  /**
   * Brings one branch's checkout up to date with the remote, creating it if it
   * does not exist, and refreshes the project's memory from what is on disk.
   *
   * The analysis runs here rather than on a schedule for the same reason the
   * sync is explicit: it is the step that makes the portal's module list
   * describe the branch as it is now rather than as the last task found it.
   */
  async sync(
    projectId: string,
    userId: string,
    requestedBranch?: string | null,
  ): Promise<ProjectCheckoutSyncResult> {
    const started = Date.now();

    if (!this.enabled) {
      return {
        branch: requestedBranch ?? '',
        outcome: 'refused',
        commit: null,
        behind: null,
        historyDepth: null,
        modules: null,
        message:
          'Keeping a local clone of each project is not enabled on this deployment. Set PROJECT_CHECKOUT_ROOT to turn it on.',
        durationMs: Date.now() - started,
      };
    }

    const project = await this.projectRow(projectId);
    const access = await this.access(projectId);

    if (!access.repositoryUrl) {
      return {
        branch: requestedBranch ?? project.defaultBranch,
        outcome: 'refused',
        commit: null,
        behind: null,
        historyDepth: null,
        modules: null,
        message: 'This project has no repository connected, so there is nothing to clone.',
        durationMs: Date.now() - started,
      };
    }

    const known = await this.branchesFor(projectId, project.defaultBranch);
    const branch = requestedBranch ?? project.defaultBranch;

    /**
     * A branch that is not one of the project's declared branches is refused
     * rather than cloned. Otherwise this endpoint is a way to make the platform
     * clone an arbitrary ref of a repository it can authenticate to, and the
     * directory it lands in is derived from the name the caller supplied.
     */
    if (!known.includes(branch)) {
      return {
        branch,
        outcome: 'refused',
        commit: null,
        behind: null,
        historyDepth: null,
        modules: null,
        message: `"${branch}" is not one of this project's branches (${known.join(', ')}).`,
        durationMs: Date.now() - started,
      };
    }

    const path = this.checkoutPath(projectId, branch);
    const credential = await this.credential(access.secretRef, access);

    // The credential helper files go in a directory of their own for the
    // duration of the call: a fixed name under a shared temp directory is how
    // two concurrent operations end up chmod-ing each other's askpass script.
    const credentialDirectory = await mkdtemp(join(tmpdir(), 'cartenz-checkout-'));

    try {
      const existing = await this.isCheckout(path);

      if (!existing) {
        await mkdir(join(this.checkoutRoot(projectId)), { recursive: true });

        /**
         * Full history, always. This is the clone a person reads, and the
         * difference between it and a task's workspace is exactly what it is
         * for: `git log`, `git blame` and "why does this file look like this"
         * are answerable only with the past present.
         */
        const clone = await this.git.clone({
          remoteUrl: access.repositoryUrl,
          branch,
          destination: path,
          credentialDirectory,
          credential,
          full: true,
        });

        const state = await this.branchState(projectId, branch);
        const modules = await this.refreshMemory(projectId, path);

        // Recorded here too, not only on the fetch path: a clone is a sync, and
        // the timestamp is what the page shows instead of "never synced".
        await this.writeState(projectId, branch, clone.headCommit);

        await this.record(projectId, userId, 'cloned', branch, clone.headCommit, modules);

        return {
          branch,
          outcome: 'cloned',
          commit: clone.headCommit,
          behind: state.behind,
          historyDepth: state.historyDepth,
          modules,
          message: `Cloned ${branch} at ${clone.headCommit.slice(0, 8)}.`,
          durationMs: Date.now() - started,
        };
      }

      const pull = await this.git.pullFastForward(path, access.repositoryUrl, branch, {
        credentialDirectory,
        credential,
      });

      const state = await this.branchState(projectId, branch);
      const modules = await this.refreshMemory(projectId, path);

      await this.writeState(projectId, branch, state.commit);

      await this.record(projectId, userId, pull.outcome, branch, state.commit, modules);

      return {
        branch,
        outcome: pull.outcome,
        commit: state.commit,
        behind: state.behind,
        historyDepth: state.historyDepth,
        modules,
        message:
          pull.outcome === 'up_to_date'
            ? `${branch} is already up to date at ${(state.commit ?? '').slice(0, 8)}.`
            : `Fast-forwarded ${branch} by ${pull.commits} commit(s) to ${(state.commit ?? '').slice(0, 8)}.`,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      /**
       * A refusal is reported as a refusal, not a failure: a checkout with local
       * edits or a diverged branch is a state a person can fix, and git's own
       * message says what is in the way. Everything else is a failure.
       */
      const refused = error instanceof GitPullRefusedError;
      const message = (error as Error).message;

      await this.record(projectId, userId, refused ? 'refused' : 'failed', branch, null, null);

      this.logger[refused ? 'warn' : 'error'](
        `Checkout sync for ${projectId} (${branch}) ${refused ? 'refused' : 'failed'}: ${message}`,
      );

      return {
        branch,
        outcome: refused ? 'refused' : 'failed',
        commit: null,
        behind: null,
        historyDepth: null,
        modules: null,
        message,
        durationMs: Date.now() - started,
      };
    } finally {
      await rm(credentialDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Re-reads the checkout and rewrites the project's memory from it, without
   * contacting the remote.
   *
   * The counterpart to `status` for the module list: a person looking at a stale
   * module list wants the list refreshed, not a network round trip, and the code
   * they are describing is already on disk.
   */
  async analyze(
    projectId: string,
    userId: string,
    requestedBranch?: string | null,
  ): Promise<{ branch: string | null; modules: number | null; message: string }> {
    const project = await this.projectRow(projectId);
    const branches = await this.branchesFor(projectId, project.defaultBranch);

    for (const branch of requestedBranch ? [requestedBranch] : branches) {
      const path = this.checkoutPath(projectId, branch);

      if (!(await this.isCheckout(path))) continue;

      const modules = await this.refreshMemory(projectId, path);
      await this.audit.record({
        event: AUDIT_EVENTS.PROJECT_CHECKOUT_ANALYSED,
        projectId,
        userId,
        metadata: { branch, modules },
      });

      return {
        branch,
        modules,
        message: `Read ${modules ?? 0} module(s) from the local clone of ${branch}.`,
      };
    }

    return {
      branch: null,
      modules: null,
      message:
        'This project has no local clone yet. Sync one first, then this can read it.',
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * The project this checkout belongs to: nothing about the name, because a
   * project's id is already a safe path segment and is stable, while a
   * technical name is derived from a directory that only exists on projects
   * that were provisioned.
   */
  private checkoutRoot(projectId: string): string {
    return join(this.config.checkouts.root as string, projectId);
  }

  private checkoutPath(projectId: string, branch: string): string {
    return join(this.checkoutRoot(projectId), escapeSegment(branch));
  }

  /** The state file for one branch, kept outside the clone. */
  private statePath(projectId: string, branch: string): string {
    return join(this.checkoutRoot(projectId), '.cartenz', `${escapeSegment(branch)}.json`);
  }

  private async isCheckout(path: string): Promise<boolean> {
    const info = await stat(join(path, '.git')).catch(() => null);
    return Boolean(info);
  }

  private async projectRow(projectId: string): Promise<{
    name: string;
    defaultBranch: string;
  }> {
    const [row] = await this.database.db
      .select({
        name: projects.name,
        defaultBranch: projects.defaultBranch,
      })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    /**
     * A project row a caller reached through the authorisation service always
     * exists; this guard is for the case where it was deleted between the two
     * reads, which is a race rather than a programming error.
     */
    if (!row) throw new Error(`Project ${projectId} not found`);
    return row;
  }

  private async access(projectId: string) {
    const [row] = await this.database.db
      .select({
        repositoryUrl: projects.repositoryUrl,
        defaultBranch: projects.defaultBranch,
        gitCredentialId: projects.gitCredentialId,
        gitUsername: projects.gitUsername,
        gitTransport: projects.gitTransport,
      })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    if (!row) throw new Error(`Project ${projectId} not found`);

    return resolveProjectGitAccess(
      { database: this.database, gitCredentials: this.gitCredentials },
      { projectId, ...row },
    );
  }

  private async credential(
    secretRef: string | null,
    access: { credentialKind: 'token' | 'ssh_key'; sshHostKey: string | null; credentialUsername: string | null },
  ): Promise<GitCredential | null> {
    if (!secretRef) return null;

    return {
      kind: access.credentialKind,
      value: await this.secrets.read(secretRef),
      hostKey: access.sshHostKey,
      username: access.credentialUsername,
    };
  }

  /**
   * Every branch this project works on: its default branch, plus a branch per
   * environment. Deduplicated, because an environment commonly sits on the
   * default branch and cloning the same branch twice would be two directories
   * claiming to be the same thing.
   */
  private async branchesFor(projectId: string, defaultBranch: string): Promise<string[]> {
    const rows = await this.database.db
      .select({ branch: projectEnvironments.branch })
      .from(projectEnvironments)
      .where(eq(projectEnvironments.projectId, projectId));

    return [...new Set([defaultBranch, ...rows.map((row) => row.branch)])];
  }

  private async branchState(projectId: string, branch: string): Promise<CheckoutBranchState> {
    const path = this.checkoutPath(projectId, branch);

    if (!(await this.isCheckout(path))) {
      return {
        branch,
        path,
        exists: false,
        commit: null,
        remoteCommit: null,
        behind: null,
        dirty: false,
        historyDepth: null,
        lastSyncedAt: null,
      };
    }

    const commit = await this.git.headOf(path, 'HEAD');
    const remoteCommit = await this.git.headOf(path, `refs/remotes/origin/${branch}`);
    const status = await this.git.status(path).catch(() => null);

    /**
     * The count needs both commits present locally, which they are after a fetch
     * and are not before the first one. Null says "cannot be compared", which is
     * the truth; reporting 0 would say "up to date" about a checkout that has
     * never been compared to anything.
     */
    const behind =
      commit && remoteCommit ? await this.git.countCommits(path, commit, remoteCommit) : null;

    const historyDepth = await this.git.countReachable(path, 'HEAD');

    return {
      branch,
      path,
      exists: true,
      commit,
      remoteCommit,
      behind,
      dirty: status ? !status.clean : false,
      historyDepth,
      lastSyncedAt: await this.readState(projectId, branch),
    };
  }

  private async readState(projectId: string, branch: string): Promise<string | null> {
    const raw = await readFile(this.statePath(projectId, branch), 'utf8').catch(() => null);
    if (!raw) return null;

    try {
      return (JSON.parse(raw) as CheckoutState).lastSyncedAt ?? null;
    } catch {
      // A corrupt state file is not worth failing a read over; the checkout
      // itself is the evidence, and this is only the timestamp.
      return null;
    }
  }

  private async writeState(
    projectId: string,
    branch: string,
    commit: string | null,
  ): Promise<void> {
    const path = this.statePath(projectId, branch);
    await mkdir(join(this.checkoutRoot(projectId), '.cartenz'), { recursive: true });

    const state: CheckoutState = {
      branch,
      lastSyncedAt: new Date().toISOString(),
      commit,
    };

    await writeFile(path, JSON.stringify(state, null, 2), 'utf8');
  }

  /**
   * Re-runs the analysis over the checkout and stores it as the project's memory.
   *
   * Returns the module count, or null when the analysis threw: a repository the
   * analyser cannot read is not a reason to fail a sync that already brought the
   * code down, and the count is reported to a person who can see the code on
   * disk regardless.
   */
  private async refreshMemory(projectId: string, path: string): Promise<number | null> {
    try {
      const analysis = await this.analyser.analyse(path);

      await this.memory.record({
        projectId,
        // No task is responsible for this read, and the column is nullable:
        // inventing a task id here would attribute the analysis to a run that
        // never happened.
        taskId: null,
        analysis,
      });

      return analysis.modules.length;
    } catch (error) {
      this.logger.warn(
        `Analysis of the local clone for ${projectId} failed: ${(error as Error).message}`,
      );
      return null;
    }
  }

  private async record(
    projectId: string,
    userId: string,
    outcome: string,
    branch: string,
    commit: string | null,
    modules: number | null,
  ): Promise<void> {
    await this.audit.record({
      event: AUDIT_EVENTS.PROJECT_CHECKOUT_SYNCED,
      projectId,
      userId,
      metadata: { outcome, branch, commit, modules },
    });
  }
}

/**
 * Keeps a branch or project name safe as a single directory name.
 *
 * `Staging`, `feature/PAY-12` and `release-2.0` all have to become one path
 * segment, and a branch name is attacker-influenced in the sense that it comes
 * from a repository. Everything outside the allowed set becomes a hyphen rather
 * than being escaped, so a name can never introduce a separator.
 *
 * Exported because the property is asserted directly: this is a security
 * boundary (a branch name comes from a repository and becomes a directory), and
 * boundaries are the part worth a test of its own.
 */
export function escapeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 128);
}