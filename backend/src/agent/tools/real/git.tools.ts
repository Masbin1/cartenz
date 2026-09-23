import { Inject, Injectable } from '@nestjs/common';
import { GitService } from '../../git/git.service';
import { assertSafeRefName } from '../../git/git-url';
import {
  GIT_BRANCH_SCHEMA,
  GIT_COMMIT_SCHEMA,
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
    return [this.gitStatus, this.gitDiff, this.gitBranch, this.gitCommit, this.gitPush];
  }

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
          `This workspace holds ${head.slice(0, 8)}, but the task recorded its commit as ` +
            `${input.commit.slice(0, 8)}. The workspace is not the one that holds this ` +
            'task\'s work, so pushing from it would deliver nothing.',
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
