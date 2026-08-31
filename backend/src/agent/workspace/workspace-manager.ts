import { Inject, Injectable, Logger } from '@nestjs/common';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { APP_CONFIG } from '../../core/config/config.module';
import type { AppConfig } from '../../core/config/configuration';
import { DatabaseService } from '../../core/database/database.service';
import { agentWorkspaces } from '../../core/database/schema';
import { GitService } from '../git/git.service';
import { SECRETS_PROVIDER, type SecretsProvider } from '../../core/secrets/secrets.provider';

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
   * A host key accepted on first contact, for the caller to record on the
   * connection so that the next clone can verify strictly (ADR-021).
   */
  readonly learnedHostKey?: string | null;
}

export interface AllocateWorkspaceInput {
  readonly taskId: string;
  readonly taskReference: string;
  readonly organizationId: string;
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
   * creates the AI branch.
   *
   * A project with no repository - an `ai_project` - still gets a workspace, so
   * that the analysis and planning states have somewhere to work and the tool
   * layer behaves identically. It is marked `simulated` because no clone exists.
   */
  async allocate(input: AllocateWorkspaceInput): Promise<Workspace> {
    const workspaceId = `ws-${randomUUID().slice(0, 8)}`;
    const root = join(this.root, `task-${sanitiseSegment(input.taskReference)}-${workspaceId}`);
    const repositoryPath = join(root, 'repository');
    const metadataPath = join(root, 'metadata');
    const logsPath = join(root, 'logs');
    const branch = buildAiBranchName(input.taskReference, input.prompt);

    await mkdir(metadataPath, { recursive: true });
    await mkdir(logsPath, { recursive: true });

    // Recorded before the clone: an interrupted clone must leave evidence.
    await this.database.db.insert(agentWorkspaces).values({
      id: undefined,
      workspaceRef: workspaceId,
      taskId: input.taskId,
      organizationId: input.organizationId,
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
        learnedHostKey: null,
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

      await this.git.createBranch(repositoryPath, branch);

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
        learnedHostKey: this.learnedHostKeys.get(workspaceId) ?? null,
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
