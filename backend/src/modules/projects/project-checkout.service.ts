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
import { checkoutPathFor } from '../../agent/git/project-checkout-paths';
import { OdooProjectAnalyser } from '../../agent/analysis/odoo-project-analyser';
import { ProjectMemoryService } from '../../agent/analysis/project-memory.service';
import { GitCredentialsService } from '../settings/git-credentials.service';
import { projectEnvironments } from '../../core/database/schema';

/** What one branch of the project's clone looks like. */
export interface CheckoutBranchState {
  readonly branch: string;
  /** Absolute path of the project's clone, or the path it would occupy. */
  readonly path: string;
  /** True when the clone holds a local branch of this name. */
  readonly exists: boolean;
  /** The local branch's tip. Null when there is no local branch yet. */
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
  /** Commits the local branch is behind the remote, as of the last fetch. */
  readonly behind: number | null;
  /** Commits the local branch has that the remote does not (unpushed work). */
  readonly ahead: number | null;
  /** A task's worktree on this branch has uncommitted changes. */
  readonly dirty: boolean;
  /** A running task has this branch checked out in its worktree. */
  readonly inUse: boolean;
  /** Commits reachable from the local branch - proves the clone is not shallow. */
  readonly historyDepth: number | null;
  readonly lastSyncedAt: string | null;
}

export interface ProjectCheckoutStatus {
  /** False when this deployment has no PROJECT_CHECKOUT_ROOT. */
  readonly enabled: boolean;
  readonly reason: string | null;
  readonly root: string | null;
  /** The one clone's path, whether or not it exists yet. */
  readonly path: string | null;
  /** True once the project's clone exists on disk. */
  readonly cloned: boolean;
  readonly branches: readonly CheckoutBranchState[];
}

export interface ProjectCheckoutSyncResult {
  readonly branch: string;
  readonly outcome: 'cloned' | 'up_to_date' | 'fast_forwarded' | 'refused' | 'failed';
  readonly commit: string | null;
  readonly behind: number | null;
  /** Commits in the branch's history after the sync. */
  readonly historyDepth: number | null;
  /** Modules the refreshed analysis found, when it ran. */
  readonly modules: number | null;
  /** What happened, in a sentence a person can read. */
  readonly message: string;
  readonly durationMs: number;
}

/** The state file written beside the clone, one per branch. */
interface CheckoutState {
  readonly branch: string;
  readonly lastSyncedAt: string;
  readonly commit: string | null;
}

/**
 * One clone per project, kept between tasks, and the source every task's
 * working tree comes from (ADR-063).
 *
 * Why this exists: a task used to clone the repository into a workspace that
 * was deleted when the task ended, so this platform held a project's source
 * only while a task was running. Reading a project - what modules it has, how
 * the code came to look the way it does - meant submitting a task and waiting,
 * the portal's view of a project was whatever the last task happened to
 * analyse, and every task re-downloaded the whole repository.
 *
 * The model is a developer's laptop. The repository is cloned once, when the
 * project is connected, with full history and every branch, into
 * `PROJECT_CHECKOUT_ROOT/<project id>/repo`. Choosing a branch - the chat's
 * Target picker - is choosing which local branch a task works on; nothing is
 * cloned again. A task gets a `git worktree` of that branch (see
 * `WorkspaceManager`), so the objects live once and each task still has a
 * directory of its own that is removed when it ends.
 *
 * The clone's own checkout is always detached. git lets a branch be checked out
 * in one working tree only, so a clone sitting on `Development` would refuse
 * every task that wanted `Development`. Detached, it holds no branch and still
 * has the files on disk to read.
 *
 * Syncing is explicit - a person pressing a button - and means: fetch every
 * branch from the remote, then fast-forward each project branch that is behind
 * and not checked out by a running task. A branch with local commits the remote
 * lacks, or one a task is working on, is left alone and reported: moving it
 * would discard work or change files under a running task. That is the same
 * pull-only rule `git_pull` follows; nothing here ever pushes.
 *
 * Nothing here is `sudo`-gated, because unlike a provisioned instance this
 * directory is owned by the platform user: it lives under the platform's own
 * runtime root, not under `/opt/odoo/projects`, which is `odoo:odoo` mode 750.
 */
@Injectable()
export class ProjectCheckoutService {
  private readonly logger = new Logger(ProjectCheckoutService.name);

  /**
   * One sync per project at a time. Two fetches into the same clone contend
   * for the same ref locks and one fails with a message about `.lock` files;
   * the second caller waits for the first instead.
   */
  private readonly inFlight = new Map<string, Promise<unknown>>();

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
   * The project's clone path when it exists on disk, otherwise null.
   *
   * What the workspace layer asks before handing a task a worktree: null means
   * "clone per task as before", which keeps a deployment without a checkout
   * root, or a project not yet synced, working exactly as it did.
   */
  async existingCheckout(projectId: string): Promise<string | null> {
    if (!this.enabled) return null;
    const path = this.repoPath(projectId);
    return (await this.isCheckout(path)) ? path : null;
  }

  /**
   * What is on disk for this project, read without touching the network.
   *
   * Every branch the project works on - its default branch and each
   * environment's - is reported whether or not the clone exists yet, so the page
   * can offer to bring it in rather than showing nothing with no way to ask.
   */
  async status(projectId: string): Promise<ProjectCheckoutStatus> {
    if (!this.enabled) {
      return {
        enabled: false,
        reason:
          'Keeping a local clone of each project is not enabled on this deployment. Set PROJECT_CHECKOUT_ROOT to turn it on.',
        root: null,
        path: null,
        cloned: false,
        branches: [],
      };
    }

    const project = await this.projectRow(projectId);
    const access = await this.access(projectId);

    /**
     * With no repository there is nothing to list: showing branch names that
     * cannot be fetched invites someone to press Sync on a project that has
     * nowhere to sync from. The reason is the whole answer.
     */
    if (!access.repositoryUrl) {
      return {
        enabled: true,
        reason: 'This project has no repository connected, so there is nothing to clone.',
        root: this.config.checkouts.root,
        path: null,
        cloned: false,
        branches: [],
      };
    }

    const branches = await this.branchesFor(projectId, project.defaultBranch);
    const path = this.repoPath(projectId);
    const cloned = await this.isCheckout(path);
    const worktrees = cloned ? await this.taskWorktrees(path) : new Map<string, string>();

    return {
      enabled: true,
      reason: null,
      root: this.config.checkouts.root,
      path,
      cloned,
      branches: await Promise.all(
        branches.map((branch) => this.branchState(projectId, branch, cloned, worktrees)),
      ),
    };
  }

  /**
   * Brings the project's clone up to date with the remote - cloning it on first
   * use - and refreshes the project's memory from the chosen branch.
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
    const previous = this.inFlight.get(projectId) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(() => this.syncNow(projectId, userId, requestedBranch));

    this.inFlight.set(projectId, run);
    try {
      return await run;
    } finally {
      if (this.inFlight.get(projectId) === run) this.inFlight.delete(projectId);
    }
  }

  /**
   * Fetches every branch into an existing clone, for a task about to start
   * (ADR-063).
   *
   * A task used to clone, so it always started from the remote's tip; taking a
   * worktree from a clone fetched yesterday would quietly start it from
   * yesterday. Serialised with `sync` for the same lock reason.
   */
  async refreshForTask(projectId: string): Promise<void> {
    const previous = this.inFlight.get(projectId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
      const access = await this.access(projectId);
      if (!access.repositoryUrl) return;
      await this.withCredential(access, (credentialDirectory, credential) =>
        this.git.fetchAll(this.repoPath(projectId), access.repositoryUrl as string, {
          credentialDirectory,
          credential,
        }),
      );
    });

    this.inFlight.set(projectId, run);
    try {
      await run;
    } finally {
      if (this.inFlight.get(projectId) === run) this.inFlight.delete(projectId);
    }
  }

  private async syncNow(
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
     * A branch that is not one of the project's declared branches is refused.
     * Otherwise this endpoint is a way to make the platform read an arbitrary
     * ref of a repository it can authenticate to and record it as the
     * project's code.
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

    const path = this.repoPath(projectId);

    try {
      const existing = await this.isCheckout(path);
      let outcome: ProjectCheckoutSyncResult['outcome'];
      let advanced = 0;

      await this.withCredential(access, async (credentialDirectory, credential) => {
        if (!existing) {
          await mkdir(this.projectDir(projectId), { recursive: true });

          /**
           * Full history and every branch, always. This is the clone a person
           * reads and every task works from: `git log`, `git blame` and "why
           * does this file look like this" are answerable only with the past
           * present, and choosing another branch must not mean another
           * download.
           */
          await this.git.clone({
            remoteUrl: access.repositoryUrl as string,
            branch: project.defaultBranch,
            destination: path,
            credentialDirectory,
            credential,
            full: true,
            allBranches: true,
          });
        } else {
          await this.git.fetchAll(path, access.repositoryUrl as string, {
            credentialDirectory,
            credential,
          });
        }
      });

      // Hold no branch: every one of them must stay available to a task's
      // worktree. The files stay on disk for the analysis below.
      await this.git.detachAt(path, project.defaultBranch, 'remote');

      const worktrees = await this.taskWorktrees(path);

      for (const name of known) {
        // A declared branch the remote does not have is reported, not created:
        // there is nothing to create it from.
        if (!(await this.git.hasRef(path, `refs/remotes/origin/${name}`))) continue;

        if (!(await this.git.hasRef(path, `refs/heads/${name}`))) {
          await this.git.branchAt(path, name, name);
          continue;
        }

        // A running task's branch is left exactly where the task has it.
        if (worktrees.has(name)) continue;

        advanced += await this.fastForwardLocal(path, name);
      }

      outcome = !existing ? 'cloned' : advanced > 0 ? 'fast_forwarded' : 'up_to_date';

      const state = await this.branchState(projectId, branch, true, worktrees);

      if (!state.exists) {
        await this.record(projectId, userId, 'refused', branch, null, null);
        return {
          branch,
          outcome: 'refused',
          commit: null,
          behind: null,
          historyDepth: null,
          modules: null,
          message: `The remote has no branch "${branch}". Every other branch was fetched.`,
          durationMs: Date.now() - started,
        };
      }

      const modules = await this.analyseBranch(projectId, path, branch);
      await this.writeState(projectId, branch, state.commit);
      await this.record(projectId, userId, outcome, branch, state.commit, modules);

      return {
        branch,
        outcome,
        commit: state.commit,
        behind: state.behind,
        historyDepth: state.historyDepth,
        modules,
        message: this.describe(outcome, branch, state, advanced),
        durationMs: Date.now() - started,
      };
    } catch (error) {
      /**
       * A refusal is reported as a refusal, not a failure: a diverged branch is
       * a state a person can fix, and git's own message says what is in the
       * way. Everything else is a failure.
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
    }
  }

  /**
   * Re-reads one branch of the clone and rewrites the project's memory from it,
   * without contacting the remote.
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
    const path = this.repoPath(projectId);
    const branch = requestedBranch ?? project.defaultBranch;

    if (!(await this.isCheckout(path)) || !(await this.git.hasRef(path, `refs/heads/${branch}`))) {
      return {
        branch: null,
        modules: null,
        message: 'This project has no local clone of that branch yet. Sync first, then this can read it.',
      };
    }

    const known = await this.branchesFor(projectId, project.defaultBranch);
    if (!known.includes(branch)) {
      return {
        branch: null,
        modules: null,
        message: `"${branch}" is not one of this project's branches (${known.join(', ')}).`,
      };
    }

    const modules = await this.analyseBranch(projectId, path, branch);
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

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * The project's directory. Named by project id: an id is already a safe path
   * segment and never changes, whereas a project's display name can.
   */
  private projectDir(projectId: string): string {
    return join(this.config.checkouts.root as string, projectId);
  }

  private repoPath(projectId: string): string {
    return checkoutPathFor(this.config.checkouts.root as string, projectId);
  }

  /** The state file for one branch, kept outside the clone's working tree. */
  private statePath(projectId: string, branch: string): string {
    return join(this.projectDir(projectId), '.cartenz', `${escapeSegment(branch)}.json`);
  }

  private async isCheckout(path: string): Promise<boolean> {
    const info = await stat(join(path, '.git')).catch(() => null);
    return Boolean(info?.isDirectory());
  }

  /**
   * Branches checked out by task worktrees, keyed by branch. The clone's own
   * entry is excluded: it is detached, and even if something left it on a
   * branch that is not a task holding it.
   */
  private async taskWorktrees(path: string): Promise<Map<string, string>> {
    const all = await this.git.worktreeBranches(path).catch(() => new Map<string, string>());
    for (const [branch, worktree] of all) {
      if (worktree === path) all.delete(branch);
    }
    return all;
  }

  /**
   * Moves a local branch that nobody has checked out to its remote's tip, when
   * that is a fast-forward. Returns how many commits it moved.
   *
   * `git update-ref` with the old value is a compare-and-swap: if a task moved
   * the branch in between, the update fails rather than overwriting it. A local
   * branch with commits of its own is not moved and not an error - it is
   * reported as ahead on the page, and reconciling it is a person's call.
   */
  private async fastForwardLocal(path: string, branch: string): Promise<number> {
    const local = await this.git.headOf(path, `refs/heads/${branch}`);
    const remote = await this.git.headOf(path, `refs/remotes/origin/${branch}`);
    if (!local || !remote || local === remote) return 0;

    const ahead = await this.git.countCommits(path, remote, local);
    if (ahead !== 0) return 0;

    const behind = (await this.git.countCommits(path, local, remote)) ?? 0;
    await this.git.updateBranchRef(path, branch, remote, local);
    return behind;
  }

  /**
   * Points the clone's detached checkout at a branch and analyses it.
   *
   * The local branch rather than the remote-tracking ref: after a sync they are
   * equal unless the local branch has commits of its own, and then this host's
   * copy is the one a person reading the clone is looking at.
   */
  private async analyseBranch(
    projectId: string,
    path: string,
    branch: string,
  ): Promise<number | null> {
    await this.git.detachAt(path, branch, 'local');
    return this.refreshMemory(projectId, path);
  }

  private describe(
    outcome: ProjectCheckoutSyncResult['outcome'],
    branch: string,
    state: CheckoutBranchState,
    advanced: number,
  ): string {
    const at = (state.commit ?? '').slice(0, 8);
    const tail =
      state.inUse
        ? ` ${branch} is in use by a running task and was left where the task has it.`
        : state.ahead
          ? ` ${branch} has ${state.ahead} local commit(s) the remote does not; it was not moved.`
          : '';

    if (outcome === 'cloned') return `Cloned the repository with every branch; ${branch} is at ${at}.${tail}`;
    if (outcome === 'fast_forwarded') {
      return `Fetched every branch and fast-forwarded ${advanced} commit(s); ${branch} is at ${at}.${tail}`;
    }
    return `Fetched every branch; ${branch} is up to date at ${at}.${tail}`;
  }

  private async withCredential<T>(
    access: {
      secretRef: string | null;
      credentialKind: 'token' | 'ssh_key';
      sshHostKey: string | null;
      credentialUsername: string | null;
    },
    work: (credentialDirectory: string, credential: GitCredential | null) => Promise<T>,
  ): Promise<T> {
    const credential = await this.credential(access.secretRef, access);

    // The credential helper files go in a directory of their own for the
    // duration of the call: a fixed name under a shared temp directory is how
    // two concurrent operations end up chmod-ing each other's askpass script.
    const credentialDirectory = await mkdtemp(join(tmpdir(), 'cartenz-checkout-'));
    try {
      return await work(credentialDirectory, credential);
    } finally {
      await rm(credentialDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
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
   * default branch and listing it twice would be two rows claiming to be
   * different things.
   */
  private async branchesFor(projectId: string, defaultBranch: string): Promise<string[]> {
    const rows = await this.database.db
      .select({ branch: projectEnvironments.branch })
      .from(projectEnvironments)
      .where(eq(projectEnvironments.projectId, projectId));

    return [...new Set([defaultBranch, ...rows.map((row) => row.branch)])];
  }

  /**
   * One branch's state, read entirely from disk.
   *
   * `dirty` is the task worktree's state, not the clone's: the clone's own
   * checkout is detached and nobody edits it, so the only uncommitted changes
   * that belong to a branch are those of the task working on it.
   */
  private async branchState(
    projectId: string,
    branch: string,
    cloned: boolean,
    worktrees: Map<string, string>,
  ): Promise<CheckoutBranchState> {
    const path = this.repoPath(projectId);
    const commit = cloned ? await this.git.headOf(path, `refs/heads/${branch}`) : null;

    if (!cloned || !commit) {
      return {
        branch,
        path,
        exists: false,
        commit: null,
        remoteCommit: cloned ? await this.git.headOf(path, `refs/remotes/origin/${branch}`) : null,
        behind: null,
        ahead: null,
        dirty: false,
        inUse: false,
        historyDepth: null,
        lastSyncedAt: null,
      };
    }

    const remoteCommit = await this.git.headOf(path, `refs/remotes/origin/${branch}`);

    /**
     * The counts need both commits present locally, which they are after a
     * fetch. Null says "cannot be compared", which is the truth; reporting 0
     * would say "up to date" about a branch that has never been compared to
     * anything.
     */
    const behind = remoteCommit ? await this.git.countCommits(path, commit, remoteCommit) : null;
    const ahead = remoteCommit ? await this.git.countCommits(path, remoteCommit, commit) : null;

    const worktree = worktrees.get(branch) ?? null;
    const status = worktree ? await this.git.status(worktree).catch(() => null) : null;

    return {
      branch,
      path,
      exists: true,
      commit,
      remoteCommit,
      behind,
      ahead,
      dirty: status ? !status.clean : false,
      inUse: worktree !== null,
      historyDepth: await this.git.countReachable(path, `refs/heads/${branch}`),
      lastSyncedAt: await this.readState(projectId, branch),
    };
  }

  private async readState(projectId: string, branch: string): Promise<string | null> {
    const raw = await readFile(this.statePath(projectId, branch), 'utf8').catch(() => null);
    if (!raw) return null;

    try {
      return (JSON.parse(raw) as CheckoutState).lastSyncedAt ?? null;
    } catch {
      // A corrupt state file is not worth failing a read over; the clone
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
    await mkdir(join(this.projectDir(projectId), '.cartenz'), { recursive: true });

    const state: CheckoutState = {
      branch,
      lastSyncedAt: new Date().toISOString(),
      commit,
    };

    await writeFile(path, JSON.stringify(state, null, 2), 'utf8');
  }

  /**
   * Re-runs the analysis over the clone and stores it as the project's memory.
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
 * Keeps a branch name safe as a single file name.
 *
 * `Staging`, `feature/PAY-12` and `release-2.0` all have to become one path
 * segment, and a branch name is attacker-influenced in the sense that it comes
 * from a repository. Everything outside the allowed set becomes a hyphen rather
 * than being escaped, so a name can never introduce a separator.
 *
 * Exported because the property is asserted directly: this is a security
 * boundary (a branch name comes from a repository and becomes a file name), and
 * boundaries are the part worth a test of its own.
 */
export function escapeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 128);
}
