import { Injectable } from '@nestjs/common';
import { GitService } from '../../git/git.service';
import { assertSafeRefName } from '../../git/git-url';
import { GIT_BRANCH_SCHEMA, GIT_COMMIT_SCHEMA, NO_ARGUMENTS_SCHEMA } from '../tool-schemas';
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
  constructor(private readonly git: GitService) {}

  get definitions(): readonly AnyToolDefinition[] {
    return [this.gitStatus, this.gitDiff, this.gitBranch, this.gitCommit, this.gitPush];
  }

  private readonly gitStatus: ToolDefinition<Record<string, never>> = {
    name: 'git_status',
    description: 'Report which files you have changed so far on the task branch',
    permission: 'repository_read',
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
   * Simulated (ADR-019). Push is the one operation that reaches a customer's
   * repository, and Phase 5 owns it. Registered here with leavesPlatform so it
   * still requires the `git_push` approval, and reports what it did not do.
   */
  private readonly gitPush: ToolDefinition<Record<string, never>> = {
    name: 'git_push',
    description: 'Push the task branch to the connected repository',
    permission: 'git_push',
    leavesPlatform: true,
    simulated: true,
    parameters: NO_ARGUMENTS_SCHEMA,
    // Never. The push is the one action that leaves the platform, and it is
    // gated on a human approval reached through the lifecycle, not through a loop.
    availableToModel: false,
    validate: requireObject,
    execute: async (_input, context) => ({
      branch: context.workspace.branch,
      remote: context.workspace.repositoryUrl,
      pushed: false,
      note: 'Simulated: the commit exists in the workspace but was not sent to the remote. Phase 5 implements the push.',
      simulated: true,
    }),
  };
}
