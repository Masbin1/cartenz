import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitService } from './git.service';
import type { CommandRunner, CommandResult } from '../../core/process/command-runner.service';
import type { AppConfig } from '../../core/config/configuration';

/**
 * Reading a remote's branches (Phase 1).
 *
 * The property under test is that the names offered to a person are the names the
 * repository actually advertises. A project declaring `staging` against a
 * repository whose branch is `Staging` clones nothing, and the error arrives
 * minutes later naming a missing branch rather than a typo - so the parse must
 * not normalise, deduplicate away, or reorder case.
 */
describe('GitService.listRemoteBranches', () => {
  const TAB = String.fromCharCode(9);

  const configWith = (allowLocal = false) =>
    ({
      git: {
        cloneDepth: 1,
        authorName: 'a',
        authorEmail: 'b',
        allowLocalRemotes: allowLocal,
        pushEnabled: false,
        sshHostKeyPolicy: 'accept-new',
      },
      process: { timeoutMs: 15000, maxTimeoutMs: 20000, maxOutputBytes: 65536 },
    }) as AppConfig;

  /** A runner that answers with fixed stdout and records what it was asked. */
  const runnerWith = (stdout: string, exitCode = 0) => {
    const calls: { executable: string; args: readonly string[] }[] = [];
    const runner = {
      run: (executable: string, args: readonly string[]): Promise<CommandResult> => {
        calls.push({ executable, args });
        return Promise.resolve({
          stdout,
          stderr: '',
          exitCode,
          durationMs: 1,
          timedOut: false,
          truncated: false,
        } as CommandResult);
      },
    } as unknown as CommandRunner;

    return { runner, calls };
  };

  const lines = (...entries: string[]) => entries.join('\n');
  const ref = (sha: string, name: string) => `${sha}${TAB}refs/heads/${name}`;

  it('returns the branch names a remote advertises', async () => {
    const { runner } = runnerWith(
      lines(ref('2335001', 'Staging'), ref('2335001', 'main')),
    );
    const service = new GitService(runner, configWith());

    const branches = await service.listRemoteBranches('https://github.com/o/r.git');

    expect(branches).toEqual(['Staging', 'main']);
  });

  it('preserves case, because git refs are case-sensitive', async () => {
    // The bug this method exists to prevent: `Staging` typed as `staging`.
    const { runner } = runnerWith(lines(ref('abc', 'Staging')));
    const service = new GitService(runner, configWith());

    expect(await service.listRemoteBranches('https://github.com/o/r.git')).toEqual(['Staging']);
  });

  it('keeps slashes in a branch name', async () => {
    const { runner } = runnerWith(lines(ref('abc', 'feature/thing'), ref('def', 'ai/task_1-x')));
    const service = new GitService(runner, configWith());

    expect(await service.listRemoteBranches('https://github.com/o/r.git')).toEqual([
      'ai/task_1-x',
      'feature/thing',
    ]);
  });

  it('returns nothing for a remote with no branches', async () => {
    const { runner } = runnerWith('');
    const service = new GitService(runner, configWith());

    expect(await service.listRemoteBranches('https://github.com/o/r.git')).toEqual([]);
  });

  it('ignores anything that is not a branch ref', async () => {
    const { runner } = runnerWith(
      lines(`abc${TAB}refs/tags/v1`, ref('def', 'main'), '', 'malformed-line'),
    );
    const service = new GitService(runner, configWith());

    expect(await service.listRemoteBranches('https://github.com/o/r.git')).toEqual(['main']);
  });

  it('asks git for heads only, with the url as an operand', async () => {
    const { runner, calls } = runnerWith(lines(ref('abc', 'main')));
    const service = new GitService(runner, configWith());

    await service.listRemoteBranches('https://github.com/o/r.git');

    const args = calls[0].args;
    expect(calls[0].executable).toBe('git');
    expect(args).toContain('ls-remote');
    expect(args).toContain('--heads');
    // Everything after `--` is an operand, so a url cannot be read as an option.
    expect(args.indexOf('--')).toBeLessThan(args.indexOf('https://github.com/o/r.git'));
  });

  it('refuses a url the remote-url rules refuse', async () => {
    const { runner } = runnerWith('');
    const service = new GitService(runner, configWith());

    // Same gate as clone: no new scheme is reachable through this method.
    await expect(service.listRemoteBranches('git://github.com/o/r.git')).rejects.toThrow();
    await expect(service.listRemoteBranches('ext::sh -c whoami')).rejects.toThrow();
    await expect(service.listRemoteBranches('file:///srv/repo')).rejects.toThrow();
  });

  it('permits a file:// remote only when local remotes are allowed', async () => {
    const { runner } = runnerWith(lines(ref('abc', 'main')));
    const service = new GitService(runner, configWith(true));

    expect(await service.listRemoteBranches('file:///srv/repo')).toEqual(['main']);
  });

  it('reports a failed ls-remote as a git error', async () => {
    const { runner } = runnerWith('', 128);
    const service = new GitService(runner, configWith());

    await expect(service.listRemoteBranches('https://github.com/o/r.git')).rejects.toThrow(
      /ls-remote/,
    );
  });
});

describe('GitService.listBranches', () => {
  const config = {
    git: {
      cloneDepth: 1, authorName: 'a', authorEmail: 'b',
      allowLocalRemotes: false, pushEnabled: false, sshHostKeyPolicy: 'accept-new',
    },
    process: { timeoutMs: 15000, maxTimeoutMs: 20000, maxOutputBytes: 65536 },
  } as AppConfig;

  const runnerFor = (heads: string, remotes: string) => {
    const runner = {
      run: (_executable: string, args: readonly string[]): Promise<CommandResult> => {
        const stdout = args.includes('refs/remotes/') ? remotes : heads;
        return Promise.resolve({
          stdout, stderr: '', exitCode: 0, durationMs: 1, timedOut: false, truncated: false,
        } as CommandResult);
      },
    } as unknown as CommandRunner;
    return new GitService(runner, config);
  };

  it('lists local and remote branch names, with the remote prefix stripped', async () => {
    const service = runnerFor(
      'main\nai/task_1-x\n',
      'origin/HEAD\norigin/main\norigin/Staging\n',
    );
    expect(await service.listBranches('/tmp/repo')).toEqual(['Staging', 'ai/task_1-x', 'main']);
  });

  it('deduplicates a branch present both locally and on the remote', async () => {
    const service = runnerFor('main\n', 'origin/main\n');
    expect(await service.listBranches('/tmp/repo')).toEqual(['main']);
  });
});

describe('GitService.push', () => {  const configWith = (allowLocal = false) =>
    ({
      git: {
        cloneDepth: 1,
        authorName: 'a',
        authorEmail: 'b',
        allowLocalRemotes: allowLocal,
        pushEnabled: true,
        sshHostKeyPolicy: 'accept-new',
      },
      process: { timeoutMs: 15000, maxTimeoutMs: 20000, maxOutputBytes: 65536 },
    }) as AppConfig;

  const runnerWith = (exitCode = 0) => {
    const calls: {
      executable: string;
      args: readonly string[];
      options?: { env?: Readonly<Record<string, string>> };
    }[] = [];
    const runner = {
      run: (executable: string, args: readonly string[], options?: { env?: Readonly<Record<string, string>> }) => {
        calls.push({ executable, args, options });
        return Promise.resolve({
          stdout: '',
          stderr: '',
          exitCode,
          durationMs: 1,
          timedOut: false,
          truncated: false,
        } as CommandResult);
      },
    } as unknown as CommandRunner;

    return { runner, calls };
  };

  it('pushes the branch to the same name on the remote, after `--`', async () => {
    const { runner, calls } = runnerWith();
    const service = new GitService(runner, configWith());

    await service.push({
      repositoryPath: '/tmp/repo',
      remoteUrl: 'https://github.com/o/r.git',
      branch: 'ai/task_1-x',
      credentialDirectory: '/tmp/meta',
      credential: null,
    });

    expect(calls[0].executable).toBe('git');
    const args = calls[0].args;
    expect(args).toContain('push');
    expect(args.indexOf('--')).toBeLessThan(args.indexOf('https://github.com/o/r.git'));
    expect(args).toContain('ai/task_1-x:ai/task_1-x');
  });

  it('refuses an unsafe remote url', async () => {
    const { runner } = runnerWith();
    const service = new GitService(runner, configWith());

    await expect(
      service.push({
        repositoryPath: '/tmp/repo',
        remoteUrl: 'ext::sh -c whoami',
        branch: 'ai/task_1-x',
        credentialDirectory: '/tmp/meta',
        credential: null,
      }),
    ).rejects.toThrow();
  });

  it('reports a failed push as a git error', async () => {
    const { runner } = runnerWith(128);
    const service = new GitService(runner, configWith());

    await expect(
      service.push({
        repositoryPath: '/tmp/repo',
        remoteUrl: 'https://github.com/o/r.git',
        branch: 'ai/task_1-x',
        credentialDirectory: '/tmp/meta',
        credential: null,
      }),
    ).rejects.toThrow(/push/);
  });

  it('supplies an ssh key through GIT_SSH_COMMAND and never in argv', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'linkederp-push-'));
    const { runner, calls } = runnerWith();
    const service = new GitService(runner, configWith());

    try {
      await service.push({
        repositoryPath: '/tmp/repo',
        remoteUrl: 'git@git.odoo.com:project.git',
        branch: 'ai/task_1-x',
        credentialDirectory: directory,
        credential: { kind: 'ssh_key', value: 'PRIVATE KEY\n' },
      });

      expect(calls[0].options?.env?.GIT_SSH_COMMAND).toContain('IdentitiesOnly=yes');
      expect(calls[0].options?.env?.GIT_SSH_COMMAND).toContain('StrictHostKeyChecking=accept-new');
      // The key value must not appear in any argument.
      expect(JSON.stringify(calls[0].args)).not.toContain('PRIVATE KEY');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
