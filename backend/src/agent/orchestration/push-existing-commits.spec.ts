import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { buildTestToolRegistry } from '../tools/test-registry';
import { implementationPlanSchema } from './plan-schema';
import { GitService } from '../git/git.service';
import { CommandRunner } from '../../core/process/command-runner.service';
import type { AppConfig } from '../../core/config/configuration';

const run = promisify(execFile);

/**
 * Pushing commits that already exist, and reading history to see them (ADR-083).
 *
 * Two gaps, one shape: the platform could not look at the remote, and it could not
 * deliver a commit it had not just made.
 *
 * - **Reading.** `git_status`/`git_diff` compare the tree to the workspace base,
 *   so `task_599312` answered "tidak ada commit lokal yang menunggu push" on a
 *   branch `ahead 2, behind 21`. `git_log` is the tool that answers it.
 * - **Delivering.** `validate()` completed a clean tree with "nothing to commit
 *   or push", and `commit()` would have staged nothing. A request to push
 *   pre-existing commits therefore settled as a false success. It is now planned
 *   as `delivery: 'push_existing'`, and only that plan may push from a clean tree
 *   - a read-only inspection (ADR-082) also runs clean and must never push.
 *
 * The workflow half is asserted against the source, as `git-pull-task.spec.ts`
 * does, because the routing lives inside `private validate/commit`; the schema and
 * the push itself are exercised for real.
 */
describe('pushing commits that already exist', () => {
  describe('the plan', () => {
    const minimal = {
      summary: 'Push the two commits that are on Staging but not on the remote.',
      odooVersion: '19.0',
      steps: [{ order: 1, title: 'Push Staging', detail: 'The platform pushes the branch tip.' }],
      filesToModify: [],
      validation: ['run_linter'],
      risks: [],
    };

    it('may declare that it delivers existing commits', () => {
      const parsed = implementationPlanSchema.parse({ ...minimal, delivery: 'push_existing' });

      expect(parsed.delivery).toBe('push_existing');
      expect(parsed.filesToModify).toEqual([]);
    });

    it('defaults to a committing task when the field is absent', () => {
      // The whole safety property: a push is never inferred, only declared.
      const parsed = implementationPlanSchema.parse(minimal);

      expect(parsed.delivery).toBe('commit');
    });

    it('refuses an unknown delivery', () => {
      const parsed = implementationPlanSchema.safeParse({ ...minimal, delivery: 'push_everything' });

      expect(parsed.success).toBe(false);
    });
  });

  describe('the workflow that routes it', () => {
    const workflow = readFileSync(join(__dirname, 'agent-workflow.ts'), 'utf8');

    it('reads the plan, not the clean tree alone', () => {
      expect(workflow).toMatch(/snapshot\.plan\?\.delivery \?\? 'commit'\) === 'push_existing'/);
    });

    it('counts what the remote does not have, and treats unknown as unknown', () => {
      expect(workflow).toMatch(/private async unpushedCount/);
      expect(workflow).toMatch(/if \(!resolved\) return null;/);
    });

    it('routes a clean tree with ahead commits to the push instead of completing', () => {
      const validate = workflow.slice(workflow.indexOf('private async validate('));
      const block = validate.slice(
        validate.indexOf('ahead !== null && ahead > 0'),
        validate.indexOf('ahead !== null && ahead > 0') + 400,
      );

      expect(block).toMatch(/'testing', 'committing'/);
      expect(block).toMatch(/Preparing the push/);
    });

    it('keeps the honest completion for a clean tree that is already pushed', () => {
      expect(workflow).toContain('is already at the ` +');
      expect(workflow).toContain("'remote tip: nothing was pushed.'");
      expect(workflow).toContain('nothing to commit or push');
    });

    it('does not call git_commit when the branch already holds the commits', () => {
      const commit = workflow.slice(workflow.indexOf('private async commit('));
      const head = commit.slice(0, commit.indexOf('const message = commitMessageFor'));

      expect(head).toMatch(/const cleanTree/);
      expect(head).toContain('Nothing to author');
      // The commit call must sit in the other branch, or a push-only task would
      // hit `git_commit` with nothing staged and fail as it used to.
      expect(head).not.toMatch(/callTool\(snapshot, workspace, 'git_commit'/);
    });

    it('completes an ordinary change whose tree is somehow clean, rather than pushing', () => {
      const commit = workflow.slice(workflow.indexOf('private async commit('));

      expect(commit.slice(0, commit.indexOf('if (cleanTree)') + 400)).toContain(
        'There was nothing to commit: the working tree is clean.',
      );
    });
  });

  describe('the tool that answers "is this pushed?"', () => {
    const registry = buildTestToolRegistry();

    it('is offered to the model and read-only', () => {
      const tool = registry.get('git_log');

      expect(tool).toBeDefined();
      expect(tool?.availableToModel).toBe(true);
      expect(tool?.permission).toBe('repository_read');
      expect(tool?.leavesPlatform).toBe(false);
      expect(tool?.simulated).toBe(false);
    });

    it('refuses a ref that is not a safe name', () => {
      const tool = registry.get('git_log');
      const invalid = tool?.validate?.({ ref: 'main; rm -rf /' });

      expect(invalid).toBeTruthy();
    });
  });

  describe('the push itself, against a real remote', () => {
    let sandbox: string;
    let remotePath: string;
    let projectPath: string;
    let service: GitService;

    const config = () =>
      ({
        git: {
          cloneDepth: 1,
          authorName: 'Cartenz',
          authorEmail: 'agent@example.invalid',
          allowLocalRemotes: true,
          pushEnabled: true,
          sshHostKeyPolicy: 'accept-new',
        },
        process: { timeoutMs: 20000, maxTimeoutMs: 30000, maxOutputBytes: 256 * 1024 },
        validation: { enabled: false, runtimes: '' },
      }) as unknown as AppConfig;

    const git = (cwd: string, ...args: string[]) =>
      run('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args], { cwd });

    beforeEach(async () => {
      sandbox = await mkdtemp(join(tmpdir(), 'linkederp-push-existing-'));
      remotePath = join(sandbox, 'remote.git');
      projectPath = join(sandbox, 'project');

      await run('git', ['init', '--bare', '--initial-branch=Staging', remotePath]);
      await run('git', ['init', '--initial-branch=Staging', projectPath]);
      await writeFile(join(projectPath, 'first.txt'), 'first\n', 'utf8');
      await git(projectPath, 'add', '.');
      await git(projectPath, 'commit', '-m', 'first');
      await git(projectPath, 'remote', 'add', 'origin', `file://${remotePath}`);
      await git(projectPath, 'push', 'origin', 'Staging');

      // The commits the operator has and GitHub does not.
      await writeFile(join(projectPath, 'manual.md'), 'manual\n', 'utf8');
      await git(projectPath, 'add', '.');
      await git(projectPath, 'commit', '-m', 'add the manual');

      service = new GitService(new CommandRunner(config()), config());
    });

    afterEach(async () => {
      await rm(sandbox, { recursive: true, force: true });
    });

    it('delivers a commit the task did not make', async () => {
      const before = (await run('git', ['rev-parse', 'Staging'], { cwd: remotePath })).stdout.trim();
      const origin = await service.originUrl(projectPath);
      const local = (await run('git', ['rev-parse', 'HEAD'], { cwd: projectPath })).stdout.trim();

      const result = await service.push({
        repositoryPath: projectPath,
        remoteUrl: origin as string,
        branch: 'Staging',
        credentialDirectory: sandbox,
        credential: null,
      });

      const after = (await run('git', ['rev-parse', 'Staging'], { cwd: remotePath })).stdout.trim();

      expect(result.pushed).toBe(true);
      expect(after).toBe(local);
      expect(after).not.toBe(before);
    });
  });
});
