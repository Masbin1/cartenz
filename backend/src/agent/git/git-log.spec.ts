import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { GitService } from './git.service';
import { CommandRunner } from '../../core/process/command-runner.service';
import type { AppConfig } from '../../core/config/configuration';

const run = promisify(execFile);

/**
 * Reading history, including the commits a remote does not have (ADR-083).
 *
 * The property under test is the one that was missing: `git_status` and
 * `git_diff` compare the working tree to the workspace base commit, so a clean
 * tree cannot answer "is this pushed?". `task_599312` answered "tidak ada commit
 * lokal yang menunggu push" on a branch that was two commits ahead of its remote,
 * because no offered tool could look at the remote at all.
 *
 * These run real git against a real local remote: a mocked runner would prove the
 * code calls something, not that `--not` excludes the right commits.
 */
describe('GitService.log and resolveRef', () => {
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
    sandbox = await mkdtemp(join(tmpdir(), 'linkederp-git-log-'));
    remotePath = join(sandbox, 'remote.git');
    projectPath = join(sandbox, 'project');

    await run('git', ['init', '--bare', '--initial-branch=Staging', remotePath]);
    await run('git', ['init', '--initial-branch=Staging', projectPath]);
    await writeFile(join(projectPath, 'first.txt'), 'first\n', 'utf8');
    await git(projectPath, 'add', '.');
    await git(projectPath, 'commit', '-m', 'first commit');
    await git(projectPath, 'remote', 'add', 'origin', `file://${remotePath}`);
    await git(projectPath, 'push', 'origin', 'Staging');

    // Two commits that exist only locally - the situation an operator describes as
    // "committed but not pushed".
    await writeFile(join(projectPath, 'second.txt'), 'second\n', 'utf8');
    await git(projectPath, 'add', '.');
    await git(projectPath, 'commit', '-m', 'second commit');
    await writeFile(join(projectPath, 'third.txt'), 'third\n', 'utf8');
    await git(projectPath, 'add', '.');
    await git(projectPath, 'commit', '-m', 'third commit');

    service = new GitService(new CommandRunner(config()), config());
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it('reads commits newest first, with the author and the full hash', async () => {
    const commits = await service.log(projectPath, { ref: 'Staging', limit: 5 });

    expect(commits).toHaveLength(3);
    expect(commits[0].subject).toBe('third commit');
    expect(commits[1].subject).toBe('second commit');
    expect(commits[2].subject).toBe('first commit');
    expect(commits[0].commit).toMatch(/^[0-9a-f]{40}$/);
    expect(commits[0].author).toBe('T');
  });

  it('honours the limit, because the result is published to browsers', async () => {
    const commits = await service.log(projectPath, { ref: 'Staging', limit: 1 });

    expect(commits).toHaveLength(1);
    expect(commits[0].subject).toBe('third commit');
  });

  it('lists the commits the remote does not have when given an exclude ref', async () => {
    // This is the whole point: the same call the git_log tool makes.
    const localOnly = await service.log(projectPath, {
      ref: 'Staging',
      limit: 10,
      exclude: 'origin/Staging',
    });

    expect(localOnly.map((row) => row.subject)).toEqual(['third commit', 'second commit']);
  });

  it('counts ahead and behind against the tracking ref', async () => {
    const ahead = await service.countCommits(projectPath, 'origin/Staging', 'Staging');
    const behind = await service.countCommits(projectPath, 'Staging', 'origin/Staging');

    expect(ahead).toBe(2);
    expect(behind).toBe(0);
  });

  it('refuses a ref that does not exist rather than returning an empty list', async () => {
    // Empty would read as "no commits", which is the opposite of a wrong name.
    await expect(service.log(projectPath, { ref: 'no-such-branch', limit: 5 })).rejects.toThrow();
  });

  it('answers null for a ref that does not exist, and the commit for one that does', async () => {
    await expect(service.resolveRef(projectPath, 'origin/Staging')).resolves.toMatch(/^[0-9a-f]{40}$/);
    await expect(service.resolveRef(projectPath, 'origin/never-fetched')).resolves.toBeNull();
  });
});
