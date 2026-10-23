import { Inject, Injectable } from '@nestjs/common';
import { GitService } from '../../git/git.service';
import { assertSafeRefName } from '../../git/git-url';
import {
  GIT_BRANCH_SCHEMA,
  GIT_COMMIT_SCHEMA,
  GIT_LOG_SCHEMA,
  GIT_PULL_SCHEMA,
  GIT_PUSH_SCHEMA,
  NO_ARGUMENTS_SCHEMA,
} from '../tool-schemas';
import { SECRETS_PROVIDER, type SecretsProvider } from '../../../core/secrets/secrets.provider';
import type { AnyToolDefinition, ToolDefinition, ToolExecutionContext } from '../tool.interface';

/**
 * Real Git tools (ADR-019).
 *
 * status, diff, branch and commit operate on the task's own clone through
 * GitService, which routes every invocation through the single process chokepoint.
 *
 * `git_push` is the exception and remains simulated: it is the one operation whose
 * effect leaves the platform, and Phase 5 owns it. It is registered here rather
 * than alongside the other simulated tools so that the whole Git surface is
 * visible in one file, and it reports `simulated: true` so no reader of the audit
 * trail can mistake it for a real push.
 */

function requireObject(input: unknown): string | null {
  return typeof input === 'object' && input !== null ? null : 'input must be an object';
}

function assertRepository(context: ToolExecutionContext): void {
  if (context.workspace.simulated) {
    throw new Error('This project has no repository connected, so there is no clone to operate on.');
  }
}

@Injectable()
export class RealGitTools {
  constructor(
    private readonly git: GitService,
    @Inject(SECRETS_PROVIDER) private readonly secrets: SecretsProvider,
  ) {}

  get definitions(): readonly AnyToolDefinition[] {
    return [
      this.gitStatus,
      this.gitDiff,
      this.gitLog,
      this.gitPull,
      this.gitBranch,
      this.gitCommit,
      this.gitPush,
    ];
  }

  /**
   * Brings the task branch up to date with the remote, fast-forward only.
   *
   * Offered to the model, unlike commit and push, because "pull the latest
   * changes first" is a request a person makes of the agent in words, and the
   * only way to honour it without a tool was for the model to say it could not -
   * or, worse, for the planner to invent a file change so the plan had one.
   *
   * It is safe to offer for the reasons that make push unsafe to offer, in
   * reverse: nothing leaves the platform (a fetch sends no repository content
   * out), the branch only ever moves forward to a commit the remote already
   * holds, and a divergence or an unclean tree is refused by git with the branch
   * left where it was. `repository_write` is the permission because the working
   * tree does change.
   *
   * The credential is unsealed here, on demand, exactly as for push (ADR-021,
   * ADR-058, ADR-059): the project's stored connection, never a host SSH key.
   */
  private readonly gitPull: ToolDefinition<Record<string, never>> = {
    name: 'git_pull',
    description:
      'Pull the latest commits of the task branch from the connected repository (fast-forward only). ' +
      'Use this first when the request asks to pull or update the branch. Reports "up_to_date" when there is nothing new.',
    permission: 'repository_write',
    modes: ['odoo_sh', 'on_premise'],
    leavesPlatform: false,
    simulated: false,
    parameters: GIT_PULL_SCHEMA,
    availableToModel: true,
    validate: requireObject,
    execute: async (_input, context) => {
      assertRepository(context);

      const remoteUrl =
        context.workspace.repositoryUrl ??
        (await this.git.originUrl(context.workspace.repositoryPath));

      if (!remoteUrl) {
        throw new Error(
          'There is no remote to pull from: this workspace has no repository URL and ' +
            'the repository has no "origin" remote.',
        );
      }

      const credential = context.workspace.credentialRef
        ? {
            kind: context.workspace.credentialKind,
            value: await this.secrets.read(context.workspace.credentialRef),
            hostKey: context.workspace.sshHostKey,
            username: context.workspace.credentialUsername,
          }
        : null;

      const lease = {
        credentialDirectory: context.workspace.metadataPath,
        credential,
      };

      /**
       * The branch the task works on is normally the branch a person chose, which
       * exists on the remote (ADR-046). Where the task works on a branch of its
       * own - a main-targeted environment - that branch may not exist remotely
       * yet, and the branch it was cut from is the one with anything to pull.
       */
      let source = context.workspace.branch;
      if (source !== context.workspace.baseBranch) {
        const remoteTip = await this.git.remoteBranchCommit(remoteUrl, source, lease);
        if (remoteTip === null) source = context.workspace.baseBranch;
      }

      const result = await this.git.pullFastForward(
        context.workspace.repositoryPath,
        remoteUrl,
        source,
        lease,
      );

      return {
        branch: context.workspace.branch,
        pulledFrom: `origin/${result.branch}`,
        outcome: result.outcome,
        upToDate: result.outcome === 'up_to_date',
        before: result.before,
        after: result.after,
        remoteCommit: result.remoteCommit,
        commits: result.commits,
        filesChanged: result.filesChanged,
        files: result.files,
      };
    },
  };

  private readonly gitStatus: ToolDefinition<Record<string, never>> = {
    name: 'git_status',
    description: 'Report which files you have changed so far on the task branch',
    permission: 'repository_read',
    modes: ['odoo_sh', 'on_premise'],
    leavesPlatform: false,
    simulated: false,
    parameters: NO_ARGUMENTS_SCHEMA,
    availableToModel: true,
    validate: requireObject,
    execute: async (_input, context) => {
      assertRepository(context);
      const status = await this.git.status(context.workspace.repositoryPath);
      return {
        branch: context.workspace.branch,
        clean: status.clean,
        changedFiles: status.entries.length,
        entries: status.entries.slice(0, 200),
      };
    },
  };

  private readonly gitDiff: ToolDefinition<Record<string, never>> = {
    name: 'git_diff',
    description: 'Review your own changes so far, as a summary of files and line counts',
    permission: 'repository_read',
    modes: ['odoo_sh', 'on_premise'],
    leavesPlatform: false,
    simulated: false,
    parameters: NO_ARGUMENTS_SCHEMA,
    availableToModel: true,
    validate: requireObject,
    execute: async (_input, context) => {
      assertRepository(context);
      const base = context.workspace.baseCommit ?? 'HEAD';
      const diff = await this.git.diff(context.workspace.repositoryPath, base);

      // The patch text is deliberately not returned through the tool result: it
      // would be written into the action log and published to every subscribed
      // browser on every call. It is fetched once, on demand, through
      // GET /tasks/{id}/diff.
      return {
        branch: context.workspace.branch,
        base,
        filesChanged: diff.files.length,
        linesAdded: diff.linesAdded,
        linesRemoved: diff.linesRemoved,
        patchTruncated: diff.patchTruncated,
        files: diff.files,
      };
    },
  };

  /**
   * Reads history, including what the remote does not have.
   *
   * Offered to the model because a person asks questions the working tree cannot
   * answer: "is this committed?", "is it pushed?", "what is on Staging that is not
   * on GitHub?". Without it the only tools were `git_status` and `git_diff`, and
   * both compare the tree to the workspace's *base commit* - so a clean tree
   * reported "nothing waiting to push" on a branch that was two commits ahead of
   * its remote (`task_599312`). The model noticed and said it had no way to look;
   * this is that way.
   *
   * Read-only, leaves nothing, and the counts are against the last fetch - the
   * description says so, because a stale `origin/<branch>` would otherwise be read
   * as the remote's current state.
   */
  private readonly gitLog: ToolDefinition<{ limit?: number; ref?: string }> = {
    name: 'git_log',
    description:
      'Read the branch history and its position against the remote: recent commits, how many ' +
      'commits are local only (ahead) or missing locally (behind), and the commits the remote ' +
      'does not have. Counts are against the last fetch, so call git_pull first if the remote ' +
      'may have moved. Use this to answer whether work is committed and whether it is pushed.',
    permission: 'repository_read',
    modes: ['odoo_sh', 'on_premise'],
    leavesPlatform: false,
    simulated: false,
    parameters: GIT_LOG_SCHEMA,
    availableToModel: true,
    validate: (input) => {
      if (typeof input !== 'object' || input === null) return 'input must be an object';
      const { limit, ref } = input as { limit?: unknown; ref?: unknown };

      if (limit !== undefined) {
        if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 50) {
          return 'limit must be an integer between 1 and 50';
        }
      }

      if (ref !== undefined) {
        if (typeof ref !== 'string' || ref.length === 0) return 'ref must be a non-empty string';
        try {
          assertSafeRefName(ref);
        } catch (error) {
          return (error as Error).message;
        }
      }

      return null;
    },
    execute: async (input, context) => {
      assertRepository(context);

      const path = context.workspace.repositoryPath;
      const branch = context.workspace.branch;
      const ref = input.ref ?? branch;
      const limit = input.limit ?? 20;

      // Both clone-backed and on-premise workspaces reach their remote as
      // `origin`: a clone the platform made, or the directory's own remote, which
      // the push path reads the same way.
      const tracking = `origin/${branch}`;
      const trackingExists = (await this.git.resolveRef(path, tracking)) !== null;

      const commits = await this.git.log(path, { ref, limit });
      const shaped = (rows: typeof commits) =>
        rows.map((row) => ({ ...row, shortCommit: row.commit.slice(0, 8) }));

      if (!trackingExists) {
        return {
          branch,
          ref,
          commits: shaped(commits),
          upstream: null,
          note:
            `${tracking} does not exist locally, so this branch has never been fetched from ` +
            'the remote and "ahead" cannot be counted. Call git_pull, or push it for the first time.',
        };
      }

      // ahead = commits HEAD has that the tracking ref does not; behind = the
      // reverse. Both are counts, because "2 ahead" tells a person what to do and
      // "differs" does not.
      const ahead = await this.git.countCommits(path, tracking, branch);
      const behind = await this.git.countCommits(path, branch, tracking);
      const localOnly = await this.git.log(path, { ref: branch, limit, exclude: tracking });

      return {
        branch,
        ref,
        commits: shaped(commits),
        upstream: {
          ref: tracking,
          ahead,
          behind,
          diverged: (ahead ?? 0) > 0 && (behind ?? 0) > 0,
          asOf: 'the last fetch',
        },
        localOnly: shaped(localOnly),
      };
    },
  };

  private readonly gitBranch: ToolDefinition<{ name: string }> = {
    name: 'git_branch',
    description: 'Create the isolated AI branch for the task',
    permission: 'repository_write',
    modes: ['odoo_sh', 'on_premise'],
    leavesPlatform: false,
    simulated: false,
    parameters: GIT_BRANCH_SCHEMA,
    // The workspace manager creates the branch before the model runs.
    availableToModel: false,
    validate: (input) => {
      if (typeof input !== 'object' || input === null) return 'input must be an object';
      const name = (input as { name?: unknown }).name;
      if (typeof name !== 'string' || name.length === 0) return 'name is required';
      try {
        assertSafeRefName(name);
        return null;
      } catch (error) {
        return (error as Error).message;
      }
    },
    execute: async (input, context) => {
      assertRepository(context);
      await this.git.createBranch(context.workspace.repositoryPath, input.name);
      return { branch: input.name, created: true };
    },
  };

  private readonly gitCommit: ToolDefinition<{ message: string }> = {
    name: 'git_commit',
    description: 'Commit the staged changes on the task branch',
    permission: 'git_commit',
    modes: ['odoo_sh', 'on_premise'],
    leavesPlatform: false,
    simulated: false,
    parameters: GIT_COMMIT_SCHEMA,
    // Committing happens after validation, at a defined point in the lifecycle. A
    // model that could commit could commit before its work had been reviewed.
    availableToModel: false,
    validate: (input) => {
      if (typeof input !== 'object' || input === null) return 'input must be an object';
      const message = (input as { message?: unknown }).message;
      if (typeof message !== 'string' || message.trim().length === 0) return 'message is required';
      if (message.length > 4000) return 'message must be 4000 characters or fewer';
      return null;
    },
    execute: async (input, context) => {
      assertRepository(context);
      const result = await this.git.commit(context.workspace.repositoryPath, input.message);
      return {
        branch: context.workspace.branch,
        commit: result.commit,
        filesChanged: result.filesChanged,
      };
    },
  };

  /**
   * Real (Phase 5, ADR-021). Push sends the task branch to the connected
   * repository, which is the one operation whose effect leaves the platform.
   * It is gated twice: the `git_push` approval, reached through the lifecycle
   * rather than the model, and GIT_PUSH_ENABLED at the process chokepoint, which
   * refuses the subcommand outright when false.
   *
   * The credential is unsealed here, on demand, and passed straight to the git
   * service - never held in the context, a log or a prompt.
   */
  private readonly gitPush: ToolDefinition<{ commit?: string }> = {
    name: 'git_push',
    description: 'Push the task branch to the connected repository',
    permission: 'git_push',
    modes: ['odoo_sh', 'on_premise'],
    leavesPlatform: true,
    simulated: false,
    parameters: GIT_PUSH_SCHEMA,
    // Never. The push is the one action that leaves the platform, and it is
    // gated on a human approval reached through the lifecycle, not through a loop.
    availableToModel: false,
    validate: (input) => {
      if (typeof input !== 'object' || input === null) return 'input must be an object';
      const commit = (input as { commit?: unknown }).commit;
      if (commit !== undefined && typeof commit !== 'string') {
        return 'commit must be a string when given';
      }
      return null;
    },
    execute: async (input, context) => {
      assertRepository(context);

      /**
       * On-premise has no repository URL of its own: the workspace is a directory
       * a person selected, not a clone the platform made (ADR-028). The remote to
       * push to is the one the repository already carries, read from its own
       * config and validated by `assertSafeRemoteUrl` inside `push` like any
       * other. Every other mode pushes to the URL the platform cloned from.
       */
      const remoteUrl =
        context.workspace.repositoryUrl ??
        (await this.git.originUrl(context.workspace.repositoryPath));

      if (!remoteUrl) {
        throw new Error(
          'There is no remote to push to: this workspace has no repository URL and ' +
            'the repository has no "origin" remote.',
        );
      }

      const credential = context.workspace.credentialRef
        ? {
            kind: context.workspace.credentialKind,
            value: await this.secrets.read(context.workspace.credentialRef),
            hostKey: context.workspace.sshHostKey,
            username: context.workspace.credentialUsername,
          }
        : null;

      const result = await this.git.push({
        repositoryPath: context.workspace.repositoryPath,
        remoteUrl,
        branch: context.workspace.branch,
        credentialDirectory: context.workspace.metadataPath,
        credential,
      });

      const head = await this.git.revParse(context.workspace.repositoryPath, 'HEAD');
      const remoteCommit = await this.git.remoteBranchCommit(remoteUrl, context.workspace.branch, {
        credentialDirectory: context.workspace.metadataPath,
        credential,
      });

      /**
       * Three commits must be the same commit before a task may report delivery:
       * the one the task recorded as its own, the one at the local HEAD, and the
       * one the remote branch points at.
       *
       * `git push` exiting 0 is not evidence that anything arrived. Pushing a
       * branch whose tip is already the remote's prints "Everything up-to-date"
       * and exits 0, which is exactly what a push of nothing looks like. That is
       * not theoretical: a task whose workspace had been re-cloned from the
       * remote had a HEAD identical to the remote, pushed a changed branch of no
       * commits, exited 0, and was reported to the operator as pushed - with no
       * commit on GitHub anywhere.
       *
       * The recorded commit is what makes a re-cloned workspace distinguishable
       * from a working one: both have the same HEAD, but only the workspace that
       * holds the work also holds the commit the task saved after making it.
       *
       * Verification happens here rather than in the workflow because the
       * credential is unsealed here and never leaves this layer (ADR-021).
       */
      if (remoteCommit === null) {
        throw new Error(
          `The push reported success but branch ${context.workspace.branch} does not exist ` +
            'on the remote. Nothing was delivered.',
        );
      }
      if (remoteCommit !== head) {
        throw new Error(
          `The push reported success but the remote's ${context.workspace.branch} is at ` +
            `${remoteCommit.slice(0, 8)}, not the commit this task made (${head.slice(0, 8)}). ` +
            'Nothing was delivered.',
        );
      }
      if (input.commit && input.commit !== head) {
        throw new Error(
          `This workspace holds ${head.slice(0, 8)}, but the task recorded ` +
            `${input.commit.slice(0, 8)} as the commit it settles at. This workspace ` +
            'is not the one that holds this task\'s work, so pushing from it would deliver nothing.',
        );
      }

      return {
        branch: result.branch,
        remote: remoteUrl,
        pushed: result.pushed,
        commit: head,
        remoteCommit,
        verified: true,
      };
    },
  };
}
