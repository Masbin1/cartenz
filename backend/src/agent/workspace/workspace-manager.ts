import { Inject, Injectable, Logger } from '@nestjs/common';
import { mkdir, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import { APP_CONFIG } from '../../core/config/config.module';
import type { AppConfig } from '../../core/config/configuration';
import { DatabaseService } from '../../core/database/database.service';
import { agentWorkspaces } from '../../core/database/schema';
import { GitService } from '../git/git.service';
import { SECRETS_PROVIDER, type SecretsProvider } from '../../core/secrets/secrets.provider';
import type { ExecutionMode } from '../executors/execution-mode';
import {
  readOnlyRootsFromPaths,
  type ReadOnlyRoot,
} from './workspace-path';
import { resolveOnPremiseRepository } from './on-premise-repository';

/**
 * A provisioned workspace, in the layout of chapter 8:
 *
 *   /workspaces/task-9281/
 *     repository/   the clone
 *     logs/         command output retained for the task
 *     metadata/     the askpass helper and task metadata, outside the clone
 */
export interface Workspace {
  readonly workspaceId: string;
  readonly taskReference: string;
  readonly root: string;
  readonly repositoryPath: string;
  readonly metadataPath: string;
  readonly logsPath: string;
  readonly branch: string;
  readonly baseBranch: string;
  readonly baseCommit: string | null;
  readonly repositoryUrl: string | null;
  readonly odooVersion: string | null;
  /** False once a real clone exists; true when no repository was provisioned. */
  readonly simulated: boolean;
  /**
   * Shared directories the agent may read but never write (ADR-028). Empty for
   * every mode except on-premise, where it holds the configured base/enterprise
   * paths.
   */
  readonly readOnlyRoots: readonly ReadOnlyRoot[];
  /**
   * A host key accepted on first contact, for the caller to record on the
   * connection so that the next clone can verify strictly (ADR-021).
   */
  readonly learnedHostKey?: string | null;
  /**
   * Reference into the secrets store for the repository credential, and what it
   * is. A reference, never a value: the push tool unseals it at the moment it
   * needs it, exactly as the clone does.
   */
  readonly credentialRef: string | null;
  readonly credentialKind: 'token' | 'ssh_key';
  /** Recorded host key for the remote, where one is held. */
  readonly sshHostKey: string | null;
  /**
   * The account to present with a token over HTTPS (ADR-059). Null means the
   * host's convention (`x-access-token`, `oauth2`) is used instead.
   *
   * Not a secret: it is stored on the project row, reported by the settings API
   * and shown in the portal. The token it accompanies never is.
   */
  readonly credentialUsername: string | null;
}

export interface AllocateWorkspaceInput {
  readonly taskId: string;
  readonly taskReference: string;
  readonly projectId: string;
  readonly repositoryUrl: string | null;
  readonly defaultBranch: string;
  readonly odooVersion: string | null;
  readonly prompt: string;
  /** Reference into the secrets store for the repository credential. */
  readonly credentialRef: string | null;
  /** What that credential is: a token for HTTPS, or an SSH key (ADR-021). */
  readonly credentialKind: 'token' | 'ssh_key';
  /** Recorded host key for the remote, where one is held. */
  readonly sshHostKey: string | null;
  /** The account to present with a token over HTTPS (ADR-059). */
  readonly credentialUsername: string | null;
  /**
   * The execution mode this task runs in (ADR-028). Null for a project type with
   * no execution surface.
   */
  readonly executionMode: ExecutionMode | null;
  /**
   * For on-premise: the selected local custom-module directory, operated on
   * directly rather than cloned.
   */
  readonly onPremiseProjectPath: string | null;
  /**
   * The read-only Odoo source paths in force for this deployment (ADR-033).
   *
   * Undefined means the caller has no opinion and the deployment's environment
   * configuration applies (ADR-031), which is what keeps existing callers and
   * tests working.
   */
  readonly odooSourcePaths?: readonly string[];
  /**
   * The commit the change is based on, saved during a prior allocation. Null on
   * the first allocation of a task; used to tell a resumed on-premise task (whose
   * working tree already carries the agent's changes) from a fresh start.
   */
  readonly baseCommit: string | null;
  /**
   * The commit this task has already made, when it has made one.
   *
   * Used to decide whether a workspace left on disk is the *same* workspace
   * rather than merely a directory at the same path: a reattach is only allowed
   * when HEAD is this commit, because anything else is a clone that does not hold
   * the work and pushing from it would push nothing.
   */
  readonly expectedCommit?: string | null;
}

export class WorkspaceQuotaError extends Error {
  constructor(reason: string) {
    super(`The workspace quota was exceeded: ${reason}`);
    this.name = 'WorkspaceQuotaError';
  }
}

/**
 * Creates, measures and destroys per-task workspaces (ADR-019).
 *
 * This remains the seam at which microVM isolation will be introduced (ADR-013).
 * What changed in Phase 2 is that a workspace is now a real directory containing
 * a real clone, rather than a record; what has not changed is that nothing inside
 * it is ever executed.
 *
 * Two properties are deliberate:
 *
 *  1. **The clone is a sibling of the metadata, not a parent of it.** The askpass
 *     helper and task metadata live in `metadata/`, outside `repository/`, so the
 *     agent's file tools - which are contained to `repository/` - cannot read
 *     them.
 *  2. **Allocation is recorded in the database before the clone begins.** A
 *     worker that dies mid-clone leaves a row marked `allocated`, which is how an
 *     orphaned directory is found and reclaimed. A directory with no row would be
 *     invisible.
 */
@Injectable()
export class WorkspaceManager {
  private readonly logger = new Logger(WorkspaceManager.name);
  private readonly root: string;
  /** Host keys learned under `accept-new`, by workspace, for the caller to record. */
  private readonly learnedHostKeys = new Map<string, string>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly database: DatabaseService,
    private readonly git: GitService,
    @Inject(SECRETS_PROVIDER) private readonly secrets: SecretsProvider,
  ) {
    this.root = resolve(config.workspace.root);
  }

  /**
   * Provisions a workspace and, where the project has a repository, clones it and
   * checks out the branch the task works on: the environment's branch, or — for
   * `main` alone — a branch of the task's own (ADR-046).
   *
   * A project with no repository - an `ai_project` - still gets a workspace, so
   * that the analysis and planning states have somewhere to work and the tool
   * layer behaves identically. It is marked `simulated` because no clone exists.
   */
  async allocate(input: AllocateWorkspaceInput): Promise<Workspace> {
    if (input.executionMode === 'on_premise') {
      return this.allocateOnPremise(input);
    }

    /**
     * Odoo Online has no filesystem at all (ADR-028), so there is nothing to
     * allocate: the agent operates on the instance through JSON-RPC. A metadata
     * directory is still created, because the tool layer takes a workspace and
     * behaving identically is what keeps the mediated path single. Nothing is
     * cloned into it and no file tool is legal against it.
     */
    if (input.executionMode === 'odoo_online') {
      return this.allocateOdooOnline(input);
    }

    /**
     * A workspace this task already has on disk is reused rather than replaced.
     *
     * This is the fix for a change that was committed and then lost. A task
     * suspends at the push approval; the run ends, its workspace was released,
     * and the resumption - in another job, possibly another process - cloned
     * afresh from the remote. The clone has the remote's tip, not the commit the
     * first run made, so the push sent nothing, exited 0 because the branch was
     * already up to date, and the task was reported as pushed. The work existed
     * only in the directory that had been deleted.
     *
     * The directory is therefore kept while the task is between states (see
     * `release`), and reattached here. HEAD must be the commit the task recorded,
     * because a directory that has drifted is not evidence of that work.
     */
    const reattached = await this.reattach(input);
    if (reattached) return reattached;

    const workspaceId = `ws-${randomUUID().slice(0, 8)}`;
    const root = join(this.root, `task-${sanitiseSegment(input.taskReference)}-${workspaceId}`);
    const repositoryPath = join(root, 'repository');
    const metadataPath = join(root, 'metadata');
    const logsPath = join(root, 'logs');
    const branch = taskBranchFor(input.defaultBranch, input.taskReference, input.prompt);

    await mkdir(metadataPath, { recursive: true });
    await mkdir(logsPath, { recursive: true });

    // Recorded before the clone: an interrupted clone must leave evidence.
    await this.database.db.insert(agentWorkspaces).values({
      id: undefined,
      workspaceRef: workspaceId,
      taskId: input.taskId,
      projectId: input.projectId,
      rootPath: root,
      branch,
      status: 'allocated',
    });

    if (!input.repositoryUrl) {
      this.logger.log(
        `Workspace ${workspaceId} for ${input.taskReference}: no repository connected, nothing cloned`,
      );
      await this.markStatus(workspaceId, 'ready', null, 0, 0);

      return {
        workspaceId,
        taskReference: input.taskReference,
        root,
        repositoryPath,
        metadataPath,
        logsPath,
        branch,
        baseBranch: input.defaultBranch,
        baseCommit: null,
        repositoryUrl: null,
        odooVersion: input.odooVersion,
        simulated: true,
        readOnlyRoots: [],
        learnedHostKey: null,
        credentialRef: input.credentialRef,
        credentialKind: input.credentialKind,
        sshHostKey: input.sshHostKey,
        credentialUsername: input.credentialUsername,
      };
    }

    try {
      /**
       * Read only where a credential actually exists. The value goes straight to
       * the git service and is never held anywhere else - not in a field, not in a
       * log, not in the workspace record.
       */
      const credential = input.credentialRef
        ? {
            kind: input.credentialKind,
            value: await this.secrets.read(input.credentialRef),
            hostKey: input.sshHostKey,
            username: input.credentialUsername,
          }
        : null;

      const clone = await this.git.clone({
        remoteUrl: input.repositoryUrl,
        branch: input.defaultBranch,
        destination: repositoryPath,
        credentialDirectory: metadataPath,
        credential,
      });

      if (clone.learnedHostKey) {
        // Recorded so the next clone can use the strict posture. Reported through
        // the return value rather than written here: the workspace manager does not
        // own the connection record.
        this.learnedHostKeys.set(workspaceId, clone.learnedHostKey);
      }

      const usage = await this.measure(repositoryPath);
      this.assertWithinQuota(usage);

      // A branch of the task's own is created only where the task may not work on
      // the target branch itself — `main` (ADR-028). Everywhere else the clone's
      // checkout is the branch the work lands on (ADR-046).
      if (branch !== input.defaultBranch) {
        await this.git.createBranch(repositoryPath, branch);
      }

      await this.markStatus(workspaceId, 'ready', clone.headCommit, usage.bytes, usage.files);

      await writeFile(
        join(metadataPath, 'task.json'),
        JSON.stringify(
          {
            workspaceId,
            taskReference: input.taskReference,
            branch,
            baseBranch: input.defaultBranch,
            baseCommit: clone.headCommit,
            allocatedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        'utf8',
      );

      this.logger.log(
        `Workspace ${workspaceId} ready: ${usage.files} files, ${Math.round(usage.bytes / 1024)} KiB, branch ${branch}`,
      );

      return {
        workspaceId,
        taskReference: input.taskReference,
        root,
        repositoryPath,
        metadataPath,
        logsPath,
        branch,
        baseBranch: input.defaultBranch,
        baseCommit: clone.headCommit,
        repositoryUrl: input.repositoryUrl,
        odooVersion: input.odooVersion,
        simulated: false,
        readOnlyRoots: this.odooSourceRoots(input.odooSourcePaths),
        learnedHostKey: this.learnedHostKeys.get(workspaceId) ?? null,
        credentialRef: input.credentialRef,
        credentialKind: input.credentialKind,
        sshHostKey: input.sshHostKey,
        credentialUsername: input.credentialUsername,
      };
    } catch (error) {
      await this.markStatus(workspaceId, 'failed', null, 0, 0, (error as Error).message);
      // A half-provisioned workspace is removed immediately rather than left for
      // the reclaimer: it holds a partial clone of customer source.
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * The workspace this task already has on disk, when there is one that still
   * holds this task's work.
   *
   * Read from `agent_workspaces` rather than by re-deriving the directory name,
   * because the reference is recorded there and a name rebuilt from the task
   * reference is a guess. Only a row that has not been released is a candidate,
   * and the directory must still exist.
   *
   * When the task has recorded a commit, HEAD must be exactly that commit. A
   * directory whose HEAD is something else is a different state of the repository
   * and reusing it would push whatever it happens to contain.
   */
  private async reattach(input: AllocateWorkspaceInput): Promise<Workspace | null> {
    if (!input.repositoryUrl) return null;

    const [row] = await this.database.db
      .select({
        workspaceRef: agentWorkspaces.workspaceRef,
        rootPath: agentWorkspaces.rootPath,
        branch: agentWorkspaces.branch,
        baseCommit: agentWorkspaces.baseCommit,
      })
      .from(agentWorkspaces)
      .where(and(eq(agentWorkspaces.taskId, input.taskId), eq(agentWorkspaces.status, 'ready')))
      .orderBy(desc(agentWorkspaces.createdAt))
      .limit(1);

    if (!row) return null;
    if (!row.rootPath.startsWith(this.root)) {
      this.logger.error(
        `Workspace ${row.workspaceRef} records a path outside the workspace root; not reusing it`,
      );
      return null;
    }

    const root = row.rootPath;
    const repositoryPath = join(root, 'repository');
    const metadataPath = join(root, 'metadata');
    const logsPath = join(root, 'logs');

    // The clone must still be there and still be a repository.
    if (!(await this.isGitRepository(repositoryPath))) return null;

    if (input.expectedCommit) {
      const head = await this.git.revParse(repositoryPath, 'HEAD').catch(() => null);
      if (head !== input.expectedCommit) {
        this.logger.warn(
          `Workspace ${row.workspaceRef} for ${input.taskReference} is at ` +
            `${head?.slice(0, 8) ?? 'an unreadable commit'}, not the recorded ` +
            `${input.expectedCommit.slice(0, 8)}; cloning afresh instead of reusing it.`,
        );
        return null;
      }
    }

    this.logger.log(
      `Workspace ${row.workspaceRef} reused for ${input.taskReference}: the task's ` +
        'existing clone still holds its work.',
    );

    return {
      workspaceId: row.workspaceRef,
      taskReference: input.taskReference,
      root,
      repositoryPath,
      metadataPath,
      logsPath,
      branch: row.branch,
      baseBranch: input.defaultBranch,
      baseCommit: row.baseCommit,
      repositoryUrl: input.repositoryUrl,
      odooVersion: input.odooVersion,
      simulated: false,
      readOnlyRoots: this.odooSourceRoots(input.odooSourcePaths),
      learnedHostKey: this.learnedHostKeys.get(row.workspaceRef) ?? null,
      credentialRef: input.credentialRef,
      credentialKind: input.credentialKind,
      sshHostKey: input.sshHostKey,
      credentialUsername: input.credentialUsername,
    };
  }

  /** True when the path exists and is the working tree of a Git repository. */
  private async isGitRepository(path: string): Promise<boolean> {
    const info = await stat(join(path, '.git')).catch(() => null);
    if (!info) return false;

    const head = await this.git.revParse(path, 'HEAD').catch(() => null);
    return head !== null;
  }

  /**
   * Provisions the on-premise execution surface (ADR-028): no clone.
   *
   * The agent operates directly on the customer's selected local directory, so the
   * workspace's `repositoryPath` points at it rather than at a platform-owned
   * clone. The platform still owns an ephemeral metadata directory under the
   * workspace root - for logs and the task record - and it is that directory, not
   * the customer's, that `release` removes.
   *
   * The selected directory must be inside the configured ON_PREMISE_ROOT and must
   * be a Git repository. Both are refused here rather than discovered mid-task.
   */
  /**
   * A workspace record for a mode with no filesystem (ADR-028).
   *
   * Marked `simulated` for the same reason an `ai_project` is: no clone exists, so
   * any caller reasoning about a repository must take the other branch. The
   * directory holds only the task metadata; the repository path it names is never
   * created, and the file tools are refused in this mode by the validator before
   * they could look for it.
   */
  private async allocateOdooOnline(input: AllocateWorkspaceInput): Promise<Workspace> {
    const workspaceId = `ws-${randomUUID().slice(0, 8)}`;
    const root = join(this.root, `task-${sanitiseSegment(input.taskReference)}-${workspaceId}`);
    const metadataPath = join(root, 'metadata');
    const logsPath = join(root, 'logs');

    await mkdir(metadataPath, { recursive: true });
    await mkdir(logsPath, { recursive: true });

    await this.database.db.insert(agentWorkspaces).values({
      workspaceRef: workspaceId,
      taskId: input.taskId,
      projectId: input.projectId,
      rootPath: root,
      branch: 'odoo-online',
      status: 'ready',
    });

    this.logger.log(
      `Workspace ${workspaceId} for ${input.taskReference}: odoo_online, nothing cloned`,
    );

    return {
      workspaceId,
      taskReference: input.taskReference,
      root,
      repositoryPath: join(root, 'repository'),
      metadataPath,
      logsPath,
      branch: 'odoo-online',
      baseBranch: 'odoo-online',
      baseCommit: null,
      repositoryUrl: null,
      odooVersion: input.odooVersion,
      simulated: true,
      readOnlyRoots: [],
      learnedHostKey: null,
      credentialRef: null,
      credentialKind: input.credentialKind,
      sshHostKey: null,
      credentialUsername: null,
    };
  }

  private async allocateOnPremise(input: AllocateWorkspaceInput): Promise<Workspace> {
    const root = this.config.onPremise.root;
    if (!root) {
      throw new Error(
        'On-premise execution is not configured on this server (ON_PREMISE_ROOT is not set).',
      );
    }
    if (!input.onPremiseProjectPath) {
      throw new Error('This on-premise project has no local directory selected.');
    }

    const realRoot = await realpath(resolve(root)).catch(() => null);
    if (!realRoot) {
      throw new Error(`The configured ON_PREMISE_ROOT "${root}" does not exist.`);
    }

    const projectPath = await realpath(resolve(input.onPremiseProjectPath)).catch(() => null);
    if (!projectPath) {
      throw new Error(`The selected project directory "${input.onPremiseProjectPath}" does not exist.`);
    }
    if (!isInside(realRoot, projectPath)) {
      throw new Error(
        `The selected project directory "${input.onPremiseProjectPath}" is outside the configured on-premise root.`,
      );
    }
    const projectInfo = await stat(projectPath);
    if (!projectInfo.isDirectory()) {
      throw new Error(`The selected project path "${input.onPremiseProjectPath}" is not a directory.`);
    }

    /**
     * The directory that actually is the Git repository, which is not always the
     * directory that was selected (ADR-039).
     *
     * A project the operator's create_project script provisioned keeps its
     * repository in `addons/` and treats the project directory as a container for
     * `config/`, `data/`, `logs/` and that repository; a project this platform
     * scaffolded itself has the repository at its root with `addons/` inside it.
     * Both are accepted by detection rather than by configuration, the same way the
     * validation runner finds a project's modules — a project recorded before the
     * distinction was drawn still names the container, and refusing it fails every
     * task on that project for a reason that reads as the selected directory's
     * fault rather than a stale record's.
     */
    const repositoryPath = await resolveOnPremiseRepository(projectPath);
    if (!repositoryPath) {
      throw new Error(
        `The selected project directory "${input.onPremiseProjectPath}" is not a Git repository, ` +
          'and neither is the addons/ directory inside it.',
      );
    }

    const branch = input.defaultBranch;

    // On-premise works directly on the environment's branch — the branch a person
    // chose — rather than on a separate AI branch. A fresh allocation must start
    // from a clean tree so the commit only carries the agent's changes; a resumed
    // task already has the agent's own changes in the working tree, so the check
    // is skipped and the saved base commit is reused.
    if (input.baseCommit === null) {
      const status = await this.git.status(repositoryPath);
      if (!status.clean) {
        throw new Error(
          `The working tree of "${input.onPremiseProjectPath}" has uncommitted changes. ` +
            'Commit or stash them before submitting a task.',
        );
      }
    }

    await this.git.checkoutBranch(repositoryPath, branch);
    const baseCommit = input.baseCommit ?? (await this.git.revParse(repositoryPath, 'HEAD'));

    const workspaceId = `ws-${randomUUID().slice(0, 8)}`;
    const metadataRoot = join(this.root, `task-${sanitiseSegment(input.taskReference)}-${workspaceId}`);
    const metadataPath = join(metadataRoot, 'metadata');
    const logsPath = join(metadataRoot, 'logs');

    await mkdir(metadataPath, { recursive: true });
    await mkdir(logsPath, { recursive: true });

    await this.database.db.insert(agentWorkspaces).values({
      id: undefined,
      workspaceRef: workspaceId,
      taskId: input.taskId,
      projectId: input.projectId,
      rootPath: metadataRoot,
      branch,
      status: 'ready',
      baseCommit,
    });

    await writeFile(
      join(metadataPath, 'task.json'),
      JSON.stringify(
        {
          workspaceId,
          taskReference: input.taskReference,
          branch,
          baseBranch: branch,
          baseCommit,
          mode: 'on_premise',
          projectPath,
          // The directory git actually operates on, which differs from
          // `projectPath` when the repository is the project's addons/ (ADR-039).
          repositoryPath,
          allocatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      'utf8',
    );

    this.logger.log(
      `On-premise workspace ${workspaceId} ready: operating on the repository at ${repositoryPath} ` +
        `(selected directory ${projectPath}, branch ${branch})`,
    );

    return {
      workspaceId,
      taskReference: input.taskReference,
      root: metadataRoot,
      repositoryPath,
      metadataPath,
      logsPath,
      branch,
      baseBranch: branch,
      baseCommit,
      repositoryUrl: null,
      odooVersion: input.odooVersion,
      simulated: false,
      readOnlyRoots: this.odooSourceRoots(input.odooSourcePaths),
      learnedHostKey: null,
      credentialRef: input.credentialRef,
      credentialKind: input.credentialKind,
      sshHostKey: input.sshHostKey,
      credentialUsername: input.credentialUsername,
    };
  }

  /**
   * The Odoo source exposed to a task as read-only roots (ADR-031).
   *
   * Every Odoo project benefits from reading base and enterprise — a change to
   * `sale.order` is planned against how Odoo declares it — so this is no longer
   * on-premise only. The roots are read-only in the execution layer:
   * `resolveWritePath` refuses a path that lands in one, which is what makes
   * this safe rather than the prompt saying so.
   *
   * Empty when nothing is configured, in which case every read resolves inside
   * the workspace exactly as before.
   */
  private odooSourceRoots(paths?: readonly string[]): readonly ReadOnlyRoot[] {
    // Tolerate a configuration object without the section: the workspace layer
    // is constructed in tests and by callers that predate ADR-031, and an
    // absent reference means "no shared source", not a crash mid-task.
    return readOnlyRootsFromPaths(paths ?? this.config.odooSource?.paths ?? []);
  }

  /**
   * Destroys a workspace.
   *
   * Called from the workflow's terminal path. The default is to remove it: a
   * retained workspace is customer source code on platform disk, which is exactly
   * what the data-sovereignty chapter is about. Retention on failure is available
   * for debugging and is refused in production by configuration validation.
   */
  async release(workspace: Workspace, outcome: 'completed' | 'failed' = 'completed'): Promise<void> {
    const retain = outcome === 'failed' && this.config.workspace.retainOnFailure;

    if (retain) {
      await this.markStatus(workspace.workspaceId, 'retained', workspace.baseCommit, 0, 0);
      this.logger.warn(
        `Workspace ${workspace.workspaceId} retained for inspection at ${workspace.root}. ` +
          'It holds customer source code; remove it when finished.',
      );
      return;
    }

    await rm(workspace.root, { recursive: true, force: true }).catch((error: unknown) => {
      this.logger.error(
        `Failed to remove workspace ${workspace.workspaceId}: ${(error as Error).message}`,
      );
    });

    this.learnedHostKeys.delete(workspace.workspaceId);
    await this.markStatus(workspace.workspaceId, 'released', workspace.baseCommit, 0, 0);
    this.logger.log(`Workspace ${workspace.workspaceId} released`);
  }


  /**
   * Removes every workspace directory belonging to a project (ADR-024).
   *
   * Needed because a permanent delete cascades the `agent_workspaces` rows away
   * in the database and leaves the directories on disk: the row is the record of
   * a directory, not the directory itself.
   *
   * Carries the same containment guard as `reclaimOrphans`, and for the same
   * reason: removing an arbitrary path on the strength of a database value is how
   * a bug becomes data loss. A row pointing outside the configured root is logged
   * and left alone.
   */
  async discardForProject(projectId: string): Promise<number> {
    const rows = await this.database.db
      .select({
        workspaceRef: agentWorkspaces.workspaceRef,
        rootPath: agentWorkspaces.rootPath,
      })
      .from(agentWorkspaces)
      .where(eq(agentWorkspaces.projectId, projectId));

    let discarded = 0;
    for (const row of rows) {
      if (!row.rootPath.startsWith(this.root)) {
        this.logger.error(
          `Workspace ${row.workspaceRef} records a path outside the workspace root; not removing it`,
        );
        continue;
      }
      await rm(row.rootPath, { recursive: true, force: true }).catch(() => undefined);
      discarded += 1;
    }

    if (discarded > 0) {
      this.logger.log(`Discarded ${discarded} workspace director(ies) for project ${projectId}`);
    }
    return discarded;
  }
  /**
   * Removes workspace directories whose task has settled but whose workspace was
   * never released - the residue of a worker killed mid-task.
   *
   * Reported rather than silent: an orphan means a worker died, which is worth
   * knowing about.
   */
  async reclaimOrphans(): Promise<number> {
    const stale = await this.database.db
      .select({
        workspaceRef: agentWorkspaces.workspaceRef,
        rootPath: agentWorkspaces.rootPath,
        baseCommit: agentWorkspaces.baseCommit,
      })
      .from(agentWorkspaces)
      .where(eq(agentWorkspaces.status, 'allocated'));

    let reclaimed = 0;
    for (const row of stale) {
      // Only inside the configured root: a row with an unexpected path is left
      // alone rather than removed, because removing an arbitrary path on the
      // strength of a database value is how a bug becomes data loss.
      if (!row.rootPath.startsWith(this.root)) {
        this.logger.error(
          `Workspace ${row.workspaceRef} records a path outside the workspace root; not removing it`,
        );
        continue;
      }
      await rm(row.rootPath, { recursive: true, force: true }).catch(() => undefined);
      await this.markStatus(row.workspaceRef, 'released', row.baseCommit, 0, 0);
      reclaimed += 1;
    }

    if (reclaimed > 0) {
      this.logger.warn(`Reclaimed ${reclaimed} orphaned workspace(s) from an interrupted worker`);
    }
    return reclaimed;
  }

  /** Recursive size and file count, used for the quota check. */
  async measure(directory: string): Promise<{ bytes: number; files: number }> {
    let bytes = 0;
    let files = 0;

    const walk = async (current: string): Promise<void> => {
      // Stops early once the quota is already exceeded: measuring the whole of an
      // oversized clone serves no purpose.
      if (bytes > this.config.workspace.maxBytes || files > this.config.workspace.maxFiles) return;

      const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const path = join(current, entry.name);
        if (entry.isSymbolicLink()) {
          // Counted but not followed: following would double-count, and a link
          // out of the workspace is refused at read time anyway.
          files += 1;
          continue;
        }
        if (entry.isDirectory()) {
          await walk(path);
          continue;
        }
        const info = await stat(path).catch(() => null);
        if (info) {
          bytes += info.size;
          files += 1;
        }
      }
    };

    await walk(directory);
    return { bytes, files };
  }

  private assertWithinQuota(usage: { bytes: number; files: number }): void {
    if (usage.bytes > this.config.workspace.maxBytes) {
      throw new WorkspaceQuotaError(
        `the repository is ${Math.round(usage.bytes / 1048576)} MiB, above the ${Math.round(
          this.config.workspace.maxBytes / 1048576,
        )} MiB limit`,
      );
    }
    if (usage.files > this.config.workspace.maxFiles) {
      throw new WorkspaceQuotaError(
        `the repository has ${usage.files} files, above the ${this.config.workspace.maxFiles} limit`,
      );
    }
  }

  private async markStatus(
    workspaceRef: string,
    status: 'allocated' | 'ready' | 'released' | 'failed' | 'retained',
    baseCommit: string | null,
    bytes: number,
    files: number,
    error?: string,
  ): Promise<void> {
    await this.database.db
      .update(agentWorkspaces)
      .set({
        status,
        baseCommit,
        bytesUsed: bytes,
        fileCount: files,
        lastError: error ?? null,
        releasedAt: status === 'released' || status === 'failed' ? new Date() : null,
      })
      .where(eq(agentWorkspaces.workspaceRef, workspaceRef));
  }
}

/** Keeps a task reference safe as a directory name. */
function sanitiseSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64);
}

/** True when `candidate` is `root` itself or lies beneath it. */
function isInside(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  return candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Builds an AI branch name in the documented format:
 * ai/task-{task_id}-{short-description}
 *
 * The description is derived from the prompt and is aggressively constrained:
 * lower case, alphanumeric and hyphens only, five words at most. A branch name
 * reaches an argument vector, a `.git` path and a remote, so anything that could
 * be read as an option or a path separator is removed rather than escaped.
 */
export function buildAiBranchName(taskReference: string, prompt: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2)
    .slice(0, 5)
    .join('-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);

  const reference = taskReference.replace(/[^A-Za-z0-9_-]/g, '');
  return slug.length > 0 ? `ai/${reference}-${slug}` : `ai/${reference}`;
}

/**
 * The branch a task's work lands on (ADR-046).
 *
 * The environment's branch is where the work goes: a person picked it, and no
 * separate AI branch stands between the commit and the branch it was asked for.
 * `main` is the single exception — the platform never works on `main` directly
 * (ADR-028) — so a main-targeted task keeps a branch of its own.
 */
export function taskBranchFor(
  defaultBranch: string,
  taskReference: string,
  prompt: string,
): string {
  return defaultBranch === 'main' ? buildAiBranchName(taskReference, prompt) : defaultBranch;
}
