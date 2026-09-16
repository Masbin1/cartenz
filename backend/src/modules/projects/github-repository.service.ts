import { Inject, Injectable, Logger } from '@nestjs/common';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { APP_CONFIG } from '../../core/config/config.module';
import type { AppConfig } from '../../core/config/configuration';
import { DatabaseService } from '../../core/database/database.service';
import { projectConnections } from '../../core/database/schema';
import { redactMetadata } from '../../core/audit/redact';
import { GitService } from '../../agent/git/git.service';
import { GitHubClient } from '../../agent/git/github-client';
import { SECRETS_PROVIDER, type SecretsProvider } from '../../core/secrets/secrets.provider';

/**
 * Gives a created project a repository on GitHub and pushes its branches into it
 * (ADR-041).
 *
 * The gap this closes is concrete: a project created here is scaffolded *on this
 * host* and nothing about it is anywhere else. `GIT_PUSH_ENABLED=true` therefore
 * changed nothing for such a project — a task's commit had no `origin` to leave
 * through, and no repository existed to receive it. Three things have to become true
 * together, and this service is where they do:
 *
 *  1. the repository exists (created here, or adopted if a previous attempt made it);
 *  2. the project's own repository points at it as `origin`, with no credential in
 *     the stored URL;
 *  3. the credential is sealed and recorded as the project's connection, so that a
 *     later task's `git_push` finds it exactly the way a clone would.
 *
 * Design notes worth keeping:
 *
 * - **The token is sealed per project rather than left in configuration alone.** The
 *   deployment's `GITHUB_TOKEN` is what creates repositories; a task's push reads a
 *   `project_connections` credential like every other mode, so the push path has one
 *   shape rather than two. `project_connections` is also what the task layer already
 *   looks up, which is why nothing had to be added to the task snapshot.
 * - **Re-running replaces the connection rather than adding one.** The first
 *   connection holding a credential is what a task uses, so a second would be dead
 *   weight at best and the wrong credential at worst; the old secret is destroyed.
 * - **A failure to push is a failure, loud and recorded.** The project and its
 *   directory are real and usable; they are kept. What is not pretended is that the
 *   repository is up to date.
 */

export interface GitHubConnectionInput {
  readonly projectId: string;
  readonly projectName: string;
  /**
   * The repository name, which is the project's directory name: it is already
   * constrained to what both git and GitHub accept, and a second naming scheme would
   * be one more thing to explain.
   */
  readonly repositoryName: string;
  readonly description: string | null;
  /** The directory that is the Git repository (ADR-039). */
  readonly gitRootPath: string;
  readonly defaultBranch: string;
  /** Every branch a task could target, so each has something on the remote. */
  readonly branches: readonly string[];
}

export interface GitHubConnectionResult {
  /** `skipped` when the deployment is not configured for this; nothing was done. */
  readonly status: 'connected' | 'skipped';
  readonly repository: string | null;
  readonly url: string | null;
  readonly pushed: readonly string[];
  /** Why nothing happened, for the log and the audit record. */
  readonly reason: string | null;
}

@Injectable()
export class GitHubRepositoryService {
  private readonly logger = new Logger(GitHubRepositoryService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly github: GitHubClient,
    private readonly git: GitService,
    private readonly database: DatabaseService,
    @Inject(SECRETS_PROVIDER) private readonly secrets: SecretsProvider,
  ) {}

  /**
   * Whether creating a project should also create and push to a repository.
   *
   * Both halves are required and neither substitutes for the other: without the
   * GitHub settings there is nowhere to create the repository, and with
   * `GIT_PUSH_ENABLED=false` the process layer refuses the push itself, so creating
   * a repository that nothing can ever be sent to would be a promise the platform
   * cannot keep.
   */
  get available(): boolean {
    return this.github.available && this.config.git.pushEnabled;
  }

  /** Why `available` is false, in the operator's terms — null when it is true. */
  get unavailableReason(): string | null {
    if (this.available) return null;
    if (!this.config.github.repositoryEnabled) {
      return (
        'GitHub repository creation is off (set GITHUB_REPOSITORY_ENABLED=true, ' +
        'GITHUB_TOKEN and GITHUB_OWNER to enable it)'
      );
    }
    if (!this.config.git.pushEnabled) {
      return 'GIT_PUSH_ENABLED=false, so the push that would populate the repository is refused';
    }
    return 'GitHub is not configured on this deployment';
  }

  /**
   * Creates or adopts the repository, points the project's repository at it, seals
   * the credential and pushes every branch it has.
   *
   * Throws on any failure. The caller decides what that means for the project — this
   * platform creates the project and its directory first, and a repository that could
   * not be arranged is not a reason to throw away a working Odoo instance.
   */
  async connect(input: GitHubConnectionInput): Promise<GitHubConnectionResult> {
    if (!this.available) {
      const reason = this.unavailableReason ?? 'GitHub is not configured';
      return { status: 'skipped', repository: null, url: null, pushed: [], reason };
    }

    const token = this.config.github.token;
    if (!token) {
      throw new Error('GITHUB_TOKEN is not set, so no repository can be created.');
    }

    const repository = await this.github.ensureRepository({
      name: input.repositoryName,
      description: input.description,
    });

    // Before any push: the project's own repository has to point somewhere, and the
    // URL is stored without a credential in it.
    await this.git.setRemote(input.gitRootPath, 'origin', repository.cloneUrl);

    const secretRef = (
      await this.secrets.write({
        projectId: input.projectId,
        purpose: 'github-token',
        value: token,
      })
    ).ref;

    await this.recordConnection(input, repository.fullName, repository.htmlUrl, repository.cloneUrl, secretRef);

    const pushed = await this.pushBranches(input, repository.cloneUrl, token);

    this.logger.log(
      `Project "${input.projectName}" is backed by ${repository.fullName} ` +
        `(${repository.created ? 'created' : 'adopted'}); pushed ${pushed.join(', ')}`,
    );

    return {
      status: 'connected',
      repository: repository.fullName,
      url: repository.htmlUrl,
      pushed,
      reason: null,
    };
  }

  /**
   * Pushes the default branch and every environment branch the repository has.
   *
   * A branch the scaffold did not create is skipped rather than pushed: `push` would
   * fail on an unknown ref, and a project whose environments name branches the
   * repository does not have is a problem to report, not to paper over here.
   */
  private async pushBranches(
    input: GitHubConnectionInput,
    cloneUrl: string,
    token: string,
  ): Promise<readonly string[]> {
    const local = new Set(await this.git.listBranches(input.gitRootPath));

    const wanted = [input.defaultBranch, ...input.branches]
      .map((branch) => branch.trim())
      .filter((branch, index, all) => branch.length > 0 && all.indexOf(branch) === index);

    /**
     * The askpass helper lives in its own directory, removed whatever happens: a
     * failed push must not leave a credential helper on disk (the same contract the
     * clone path has). Temporary and outside the repository, so it is not in a tree
     * the agent's file tools can read.
     */
    const credentialDirectory = await mkdtemp(join(tmpdir(), 'linkederp-github-push-'));
    try {
      const pushed: string[] = [];
      for (const branch of wanted) {
        if (!local.has(branch)) {
          this.logger.warn(
            `Branch "${branch}" does not exist in ${input.gitRootPath}; not pushed to GitHub`,
          );
          continue;
        }

        await this.git.push({
          repositoryPath: input.gitRootPath,
          remoteUrl: cloneUrl,
          branch,
          credentialDirectory,
          credential: { kind: 'token', value: token, hostKey: null },
        });
        pushed.push(branch);
      }
      return pushed;
    } finally {
      await rm(credentialDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Records the GitHub connection on the project, replacing any previous one.
   *
   * The connection is what a task's push reads its credential from
   * (`task-repository.ts`), so this is the half that makes a later push work without
   * an operator pasting anything.
   */
  private async recordConnection(
    input: GitHubConnectionInput,
    fullName: string,
    htmlUrl: string,
    cloneUrl: string,
    secretRef: string,
  ): Promise<void> {
    const existing = await this.database.db
      .select({ id: projectConnections.id, secretRef: projectConnections.secretRef })
      .from(projectConnections)
      .where(
        and(
          eq(projectConnections.projectId, input.projectId),
          eq(projectConnections.connectionType, 'github'),
        ),
      );

    // Destroy the superseded secrets only once the replacement is sealed: a failure
    // between the two would otherwise leave the project with no credential at all.
    for (const connection of existing) {
      if (connection.secretRef) {
        await this.secrets.destroy(connection.secretRef).catch((error: unknown) => {
          this.logger.warn(
            `Could not destroy the superseded GitHub credential ${connection.id}: ` +
              `${(error as Error).message}`,
          );
        });
      }
    }
    if (existing.length > 0) {
      await this.database.db
        .delete(projectConnections)
        .where(
          and(
            eq(projectConnections.projectId, input.projectId),
            eq(projectConnections.connectionType, 'github'),
          ),
        );
    }

    await this.database.db.insert(projectConnections).values({
      projectId: input.projectId,
      connectionType: 'github',
      secretRef,
      credentialKind: 'token',
      status: 'connected',
      // What a person needs to find the repository again. No credential, and nothing
      // derived from one.
      metadata: redactMetadata({
        repository: fullName,
        url: htmlUrl,
        cloneUrl,
        branch: input.defaultBranch,
      }),
      lastCheckedAt: new Date(),
    });
  }
}
