import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, isNotNull, inArray } from 'drizzle-orm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_CONFIG } from '../../core/config/config.module';
import type { AppConfig } from '../../core/config/configuration';
import { DatabaseService } from '../../core/database/database.service';
import { projectConnections, projectEnvironments, projects } from '../../core/database/schema';
import { SECRETS_PROVIDER, type SecretsProvider } from '../../core/secrets/secrets.provider';
import { GIT_CONNECTION_TYPES } from '../../core/enums';
import { GitService } from '../../agent/git/git.service';
import { AuditService } from '../../core/audit/audit.service';
import { AUDIT_EVENTS } from '../../core/audit/audit-events';

/**
 * Promotes a project's `staging` branch onto `main` (ADR-057).
 *
 * The half ADR-049 left out. `pull-project.sh` brings an instance up to date
 * with *one* branch — it does not choose between two, and it does not combine
 * them. `main` is the branch ADR-021/028 forbid a task from writing to, which
 * is what makes it the reviewed state; nothing promoted `staging` onto it, so
 * that promotion was a hand-run `git merge` on somebody's laptop, outside the
 * platform's audit trail.
 *
 * Unlike the pull, this touches no project directory at all: it is an ordinary
 * git operation over the network, through `GitService`, using the credential the
 * project's own connection already records (ADR-041). No root script, no new
 * sudoers entry — the platform already pushes to these repositories.
 *
 * It is also the one push aimed at `main`. ADR-021 §2 refuses the *task* path
 * onto `main`, and that refusal stands; this is a different path — an explicit,
 * admin-gated action a person asked for by name — and it is recorded as such.
 */
export interface MergeToMainResult {
  readonly ok: boolean;
  /** The commit `main` now sits on, when the merge succeeded. */
  readonly commit: string | null;
  /** The branch that was merged in; always the project's staging branch. */
  readonly sourceBranch: string | null;
  readonly message: string;
  readonly durationMs: number;
}

@Injectable()
export class ProjectMergeService {
  private readonly logger = new Logger(ProjectMergeService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly git: GitService,
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    @Inject(SECRETS_PROVIDER) private readonly secrets: SecretsProvider,
  ) {}

  /**
   * Whether this deployment can merge at all.
   *
   * Merge is a push, so it sits behind the same process-layer gate every other
   * push does: with `GIT_PUSH_ENABLED=false`, `CommandRunner` refuses the push
   * itself and there is no code path that could carry this out. Reported to the
   * portal so a Merge button is never offered on a deployment where every press
   * would be refused — the failure mode ADR-040's HTTPS toggle was written to
   * avoid.
   */
  get available(): boolean {
    return this.config.git.pushEnabled;
  }

  async merge(projectId: string, userId: string): Promise<MergeToMainResult> {
    const startedAt = Date.now();

    if (!this.available) {
      return this.refuse(
        projectId,
        userId,
        'Merging is not enabled on this deployment: GIT_PUSH_ENABLED=false, so the push ' +
          'that would land on main is refused by the process layer.',
        startedAt,
      );
    }

    const [project] = await this.database.db
      .select({
        id: projects.id,
        name: projects.name,
        repositoryUrl: projects.repositoryUrl,
        defaultBranch: projects.defaultBranch,
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
        'This project has no repository, so there is nothing to merge. Connect one first.',
        startedAt,
      );
    }

    // The source is the project's own staging environment, never a branch name
    // from the request: this route promotes staging onto main and nothing else,
    // so it can never be pointed at an arbitrary branch pair. `main` as the
    // target is likewise fixed here rather than configurable.
    const [environments] = await this.database.db
      .select({ branch: projectEnvironments.branch })
      .from(projectEnvironments)
      .where(
        and(
          eq(projectEnvironments.projectId, projectId),
          eq(projectEnvironments.kind, 'staging'),
        ),
      )
      .limit(1);

    if (!environments?.branch) {
      return this.refuse(
        projectId,
        userId,
        'This project declares no staging environment, so there is no branch to promote onto ' +
          'main. Declare one first.',
        startedAt,
      );
    }

    const sourceBranch = environments.branch;
    const targetBranch = 'main';

    if (sourceBranch === targetBranch) {
      return this.refuse(
        projectId,
        userId,
        'This project\'s staging environment points at main itself, so there is nothing to merge.',
        startedAt,
      );
    }

    const credential = await this.gitCredential(projectId);
    const workspace = await mkdtemp(join(tmpdir(), 'linkederp-merge-'));
    const credentialDirectory = await mkdtemp(join(tmpdir(), 'linkederp-merge-cred-'));

    this.logger.log(
      `Merging "${project.name}" from ${sourceBranch} into ${targetBranch} ` +
        `(${project.repositoryUrl})`,
    );

    try {
      const tokenCredential = credential
        ? ({ kind: 'token', value: credential, hostKey: null } as const)
        : null;

      // Full history, not a shallow tip (ADR-057): a shallow clone has no common
      // ancestor with the branch fetched beside it, and the merge would refuse
      // with "unrelated histories" instead of merging.
      await this.git.clone({
        remoteUrl: project.repositoryUrl,
        branch: targetBranch,
        destination: workspace,
        credentialDirectory,
        credential: tokenCredential,
        full: true,
      });

      await this.git.fetchBranch(workspace, project.repositoryUrl, sourceBranch, {
        credentialDirectory,
        credential: tokenCredential,
      });

      const { commit } = await this.git.merge(
        workspace,
        `refs/remotes/origin/${sourceBranch}`,
        `Merge ${sourceBranch} into ${targetBranch} (LinkedERP)`,
      );

      await this.git.push({
        repositoryPath: workspace,
        remoteUrl: project.repositoryUrl,
        branch: targetBranch,
        credentialDirectory,
        credential: tokenCredential,
      });

      const durationMs = Date.now() - startedAt;

      await this.audit.record({
        event: AUDIT_EVENTS.PROJECT_MERGED_TO_MAIN,
        projectId,
        userId,
        metadata: {
          sourceBranch,
          targetBranch,
          commit,
          repositoryUrl: project.repositoryUrl,
        },
      });

      return {
        ok: true,
        commit,
        sourceBranch,
        message: `${sourceBranch} was merged into ${targetBranch} @ ${commit.slice(0, 8)}.`,
        durationMs,
      };
    } catch (error) {
      const detail = summarise((error as Error).message);
      return this.refuse(projectId, userId, detail, startedAt);
    } finally {
      await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
      await rm(credentialDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * The oldest connection that can supply a git credential (ADR-041).
   *
   * The same selection `ProjectDeploymentService` makes, and for the same
   * reason: a project may hold an `odoo_api` key as well as a repository, and
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
      // connection: say so, because the merge will fail at the remote with an
      // authentication error that reads like a wrong URL.
      this.logger.warn(
        `Could not read the git credential for project ${projectId}: ${(error as Error).message}`,
      );
      return null;
    }
  }

  private async refuse(
    projectId: string,
    userId: string,
    message: string,
    startedAt: number,
  ): Promise<MergeToMainResult> {
    await this.audit.record({
      event: AUDIT_EVENTS.PROJECT_MERGE_TO_MAIN_FAILED,
      projectId,
      userId,
      metadata: { error: message },
    });

    return {
      ok: false,
      commit: null,
      sourceBranch: null,
      message,
      durationMs: Date.now() - startedAt,
    };
  }
}

/**
 * A short, bounded description of a failure.
 *
 * The same treatment `ProjectDeploymentService` gives a script's output, and for
 * the same reason: a git error can quote a remote URL, and a URL is one place a
 * token can hide.
 */
export function summarise(value: string): string {
  const detail = value.trim().slice(0, 400) || 'The merge failed with no message.';
  return detail.replace(/([a-z][a-z0-9+.-]*:[/][/])[^@/\s]+@/gi, '$1[redacted]@');
}
