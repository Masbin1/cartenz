import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { GitService } from './git.service';
import { CommandRunner } from '../../core/process/command-runner.service';
import type { AppConfig } from '../../core/config/configuration';

const run = promisify(execFile);

/**
 * The single clone a project keeps, and the worktrees tasks take from it
 * (ADR-063).
 *
 * Real git, because every property here is a git behaviour rather than an
 * arrangement of arguments: that `--no-checkout` really does leave every branch
 * free for a worktree, that a worktree really does hold a branch exclusively,
 * that a detached HEAD really does free the branch it was on, and that a
 * worktree whose directory was deleted can still have its record dropped. A
 * mocked runner would assert the commands and learn none of that.
 *
 * The failure these exist to make impossible: two tasks on one branch, each with
 * its own working tree, pushing over each other.
 */
describe('GitService project checkout', () => {
  let sandbox: string;
  let remotePath: string;
  let seedPath: string;
  let service: GitService;

  const config = () =>
    ({
      git: {
        cloneDepth: 1,
        authorName: 'Cartenz',
        authorEmail: 'agent@example.invalid',
        allowLocalRemotes: true,
        pushEnabled: false,
        sshHostKeyPolicy: 'accept-new',
      },
      process: { timeoutMs: 20000, maxTimeoutMs: 30000, maxOutputBytes: 256 * 1024 },
      validation: { enabled: false, runtimes: '' },
    }) as unknown as AppConfig;

  const git = (cwd: string, ...args: string[]) =>
    run('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args], { cwd });

  const headOf = async (cwd: string, ref = 'HEAD') =>
    (await git(cwd, 'rev-parse', ref)).stdout.trim();

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'linkederp-checkout-'));
    remotePath = join(sandbox, 'remote.git');
    seedPath = join(sandbox, 'seed');

    await run('git', ['init', '--bare', '--initial-branch=Development', remotePath]);
    await run('git', ['clone', `file://${remotePath}`, seedPath]);
    await writeFile(join(seedPath, 'first.txt'), 'first\n', 'utf8');
    await git(seedPath, 'add', '.');
    await git(seedPath, 'commit', '-m', 'first');
    await git(seedPath, 'push', 'origin', 'Development');
    await git(seedPath, 'checkout', '-b', 'Staging');
    await git(seedPath, 'push', 'origin', 'Staging');

    service = new GitService(new CommandRunner(config()), config());
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  /** The clone a project keeps: no checkout, every branch, full history. */
  const cloneOnce = async () => {
    const checkout = join(sandbox, 'checkout');
    await service.clone({
      remoteUrl: `file://${remotePath}`,
      branch: 'Development',
      destination: checkout,
      credentialDirectory: sandbox,
      credential: null,
      full: true,
      allBranches: true,
    });
    return checkout;
  };

  it('brings every branch in one clone, so choosing a branch costs nothing', async () => {
    const checkout = await cloneOnce();

    // Both branches are already known locally, without a second clone or fetch.
    expect(await service.hasRef(checkout, 'refs/remotes/origin/Development')).toBe(true);
    expect(await service.hasRef(checkout, 'refs/remotes/origin/Staging')).toBe(true);
  });

  it('keeps the whole history, not one commit', async () => {
    const checkout = await cloneOnce();

    const depth = await service.countReachable(checkout, 'refs/heads/Development');
    expect(depth).toBeGreaterThanOrEqual(1);
    // A shallow clone would report the commit it stopped at as its own root and
    // fail `git log` with "--unshallow".
    await expect(git(checkout, 'rev-parse', '--is-shallow-repository')).resolves.toBeTruthy();
    expect((await git(checkout, 'rev-parse', '--is-shallow-repository')).stdout.trim()).toBe(
      'false',
    );
  });

  it('holds no branch, so any branch is available to a task', async () => {
    const checkout = await cloneOnce();

    await service.detachAt(checkout, 'Development', 'remote');

    // Detached: `HEAD` names a commit, not a branch, which is what leaves
    // Development free to be checked out by a worktree.
    await expect(git(checkout, 'symbolic-ref', '-q', 'HEAD')).rejects.toBeTruthy();
    const worktree = join(sandbox, 'task-on-development');
    await service.worktreeAttach(checkout, worktree, 'Development');
    expect((await git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim()).toBe(
      'Development',
    );
  });

  it('creates a local branch for a remote branch the clone never had', async () => {
    const checkout = await cloneOnce();
    await service.detachAt(checkout, 'Development', 'remote');

    // No local Staging yet - only the remote-tracking ref.
    expect(await service.hasRef(checkout, 'refs/heads/Staging')).toBe(false);
    await service.branchAt(checkout, 'Staging', 'Staging');

    await service.worktreeAttach(checkout, join(sandbox, 'task-staging'), 'Staging');
    expect(await service.hasRef(checkout, 'refs/heads/Staging')).toBe(true);
  });

  it('refuses a second worktree on a branch a task already holds', async () => {
    // This is the failure the whole design exists to prevent: two working trees
    // on one branch push over each other, and a commit made in one is lost.
    const checkout = await cloneOnce();
    await service.detachAt(checkout, 'Development', 'remote');
    await service.worktreeAttach(checkout, join(sandbox, 'task-a'), 'Development');

    await expect(
      service.worktreeAttach(checkout, join(sandbox, 'task-b'), 'Development'),
    ).rejects.toThrow();

    // The first task is untouched by the refusal.
    expect(await service.hasRef(checkout, 'refs/heads/Development')).toBe(true);
  });

  it('reports which branch each worktree holds', async () => {
    const checkout = await cloneOnce();
    await service.detachAt(checkout, 'Development', 'remote');
    const taskA = join(sandbox, 'task-a');
    await service.worktreeAttach(checkout, taskA, 'Development');

    const branches = await service.worktreeBranches(checkout);

    expect(branches.get('Development')).toBe(taskA);
  });

  it('frees the branch once the task\'s worktree is gone', async () => {
    const checkout = await cloneOnce();
    await service.detachAt(checkout, 'Development', 'remote');
    const taskA = join(sandbox, 'task-a');
    await service.worktreeAttach(checkout, taskA, 'Development');

    await service.worktreeRemove(checkout, taskA);

    // The record is gone, so the branch can be taken again - without this, every
    // later task on that branch is refused over a directory nobody can see.
    expect((await service.worktreeBranches(checkout)).has('Development')).toBe(false);
    await service.worktreeAttach(checkout, join(sandbox, 'task-c'), 'Development');
  });

  it('drops the record of a worktree whose directory was deleted underneath it', async () => {
    const checkout = await cloneOnce();
    await service.detachAt(checkout, 'Development', 'remote');
    const taskA = join(sandbox, 'task-a');
    await service.worktreeAttach(checkout, taskA, 'Development');

    // Exactly what `reclaimOrphans` or a killed worker leaves: files gone, git
    // never told.
    await rm(taskA, { recursive: true, force: true });

    expect((await service.worktreeBranches(checkout)).has('Development')).toBe(false);
    await service.worktreeAttach(checkout, join(sandbox, 'task-d'), 'Development');
  });

  it('fetches every branch into the clone in one call', async () => {
    const checkout = await cloneOnce();
    await git(seedPath, 'checkout', 'Staging');
    await writeFile(join(seedPath, 'second.txt'), 'second\n', 'utf8');
    await git(seedPath, 'add', '.');
    await git(seedPath, 'commit', '-m', 'second');
    await git(seedPath, 'push', 'origin', 'Staging');

    await service.fetchAll(checkout, `file://${remotePath}`, {
      credentialDirectory: sandbox,
      credential: null,
    });

    const remoteTip = await headOf(seedPath, 'refs/heads/Staging');
    expect(await service.headOf(checkout, 'refs/remotes/origin/Staging')).toBe(remoteTip);
  });

  it('moves a branch with a compare-and-swap, refusing a stale expectation', async () => {
    const checkout = await cloneOnce();
    const remoteTip = await service.headOf(checkout, 'refs/remotes/origin/Staging');
    const localTip = await service.headOf(checkout, 'refs/heads/Development');

    // The expected old value is what a task moving the branch in between would
    // change; the update must then fail rather than overwrite that task's work.
    await expect(
      service.updateBranchRef(checkout, 'Development', remoteTip as string, 'f'.repeat(40)),
    ).rejects.toThrow();
    expect(await service.headOf(checkout, 'refs/heads/Development')).toBe(localTip);

    await service.updateBranchRef(checkout, 'Development', remoteTip as string, localTip as string);
    expect(await service.headOf(checkout, 'refs/heads/Development')).toBe(remoteTip);
  });

  it('reports the clone a working tree belongs to', async () => {
    const checkout = await cloneOnce();
    await service.detachAt(checkout, 'Development', 'remote');
    const taskA = join(sandbox, 'task-a');
    await service.worktreeAttach(checkout, taskA, 'Development');

    // A worktree's `.git` is a file pointing into the clone; this is how release
    // tells a worktree of the project's clone from a per-task clone.
    const commonDir = await service.gitCommonDir(taskA);
    expect(commonDir).toBe(join(checkout, '.git'));
    expect(await service.gitCommonDir(checkout)).toBe(join(checkout, '.git'));
  });

  it('makes a worktree whose directory can be created by its parent', async () => {
    // The workspace layer creates the directory's parent before asking for the
    // worktree; an existing empty directory is what `worktree add` expects.
    const checkout = await cloneOnce();
    await service.detachAt(checkout, 'Development', 'remote');
    const taskA = join(sandbox, 'nested', 'task-a');
    await mkdir(taskA, { recursive: true });

    await service.worktreeAttach(checkout, taskA, 'Development');

    expect(await service.hasRef(checkout, 'refs/heads/Development')).toBe(true);
    expect((await git(taskA, 'rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim()).toBe(
      'Development',
    );
  });
});
