import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { isNull } from 'drizzle-orm';
import { basename, dirname } from 'node:path';
import { AppModule } from '../app.module';
import { DatabaseService } from '../core/database/database.service';
import { projects } from '../core/database/schema';
import { GitHubRepositoryService } from '../modules/projects/github-repository.service';
import { GitService } from '../agent/git/git.service';
import { resolveOnPremiseRepository } from '../agent/workspace/on-premise-repository';
import { readOnPremisePath } from '../modules/projects/projects.service';

/**
 * Gives the projects that already exist the GitHub repository they never had
 * (ADR-041).
 *
 * The feature is wired into project creation, so only projects created after it ships
 * get a remote. Everything created before it has a local directory, a git repository
 * and no `origin` — which is what the operator reported as "it does not push to
 * GitHub". This walks those projects and does for each what creation now does: create
 * or adopt the repository, point `origin` at it, seal the credential as the project's
 * connection, and push every branch.
 *
 * Idempotent: a project whose repository already has an `origin` is reported and
 * skipped unless `--force` is passed, so re-running after a partial failure is safe
 * and does not re-push a branch that is already there.
 *
 * Usage (as the `cartenz` user, from /opt/cartenz/backend):
 *
 *   npm run build                                   # the script runs from dist/
 *   node dist/scripts/backfill-github-repositories.js [--dry-run] [--force] [<project>]
 *
 * Requires GITHUB_REPOSITORY_ENABLED=true, GITHUB_TOKEN, GITHUB_OWNER and
 * GIT_PUSH_ENABLED=true: the first three to create the repository, the last because
 * the push is refused at the process layer otherwise.
 */
async function main(): Promise<void> {
  const logger = new Logger('BackfillGitHubRepositories');
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');
  const only = args.filter((arg) => !arg.startsWith('--'));

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  let failures = 0;
  try {
    const github = app.get(GitHubRepositoryService);
    const database = app.get(DatabaseService);
    const git = app.get(GitService);

    if (!dryRun && !github.available) {
      throw new Error(
        `GitHub is not usable on this deployment: ${github.unavailableReason ?? 'not configured'}`,
      );
    }

    const rows = await database.db
      .select({
        id: projects.id,
        name: projects.name,
        projectType: projects.projectType,
        defaultBranch: projects.defaultBranch,
        environmentConfig: projects.environmentConfig,
        description: projects.description,
      })
      .from(projects)
      .where(isNull(projects.archivedAt));

    for (const row of rows) {
      if (only.length > 0 && !only.includes(row.name)) continue;

      const selected = readOnPremisePath(row.environmentConfig);
      if (!selected) {
        logger.log(`${row.name}: no local directory; nothing to connect`);
        continue;
      }

      const gitRootPath = await resolveOnPremiseRepository(selected);
      if (!gitRootPath) {
        logger.warn(`${row.name}: ${selected} is not a git repository; skipped`);
        continue;
      }

      const existingOrigin = await git.originUrl(gitRootPath);
      if (existingOrigin && !force) {
        logger.log(`${row.name}: already has origin ${existingOrigin}; skipped (--force to redo)`);
        continue;
      }

      // `addons/` is the repository for a provisioned project, so the project
      // directory — not the repository directory — is what names it.
      const repositoryName = basename(gitRootPath) === 'addons'
        ? basename(dirname(gitRootPath))
        : basename(gitRootPath);

      const branches = await git.listBranches(gitRootPath);

      if (dryRun) {
        logger.log(
          `${row.name}: would create/adopt "${repositoryName}" and push ` +
            `${branches.join(', ')} from ${gitRootPath}`,
        );
        continue;
      }

      try {
        const result = await github.connect({
          projectId: row.id,
          projectName: row.name,
          repositoryName,
          description: row.description,
          gitRootPath,
          defaultBranch: row.defaultBranch,
          branches,
        });

        logger.log(
          `${row.name}: ${result.status}${result.repository ? ` -> ${result.repository}` : ''}` +
            `${result.pushed.length > 0 ? ` (pushed ${result.pushed.join(', ')})` : ''}` +
            `${result.reason ? ` (${result.reason})` : ''}`,
        );
      } catch (error) {
        failures += 1;
        logger.error(`${row.name}: failed — ${(error as Error).message}`);
      }
    }
  } finally {
    await app.close();
  }

  if (failures > 0) {
    throw new Error(`${failures} project(s) could not be connected; see the log above.`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`Backfill failed: ${(error as Error).message}\n`);
  process.exit(1);
});
