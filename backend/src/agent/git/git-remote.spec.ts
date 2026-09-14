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
 * Pointing a repository at a remote it did not come from (ADR-041).
 *
 * A project this platform creates has no `origin` at all, so the platform sets one.
 * These run real git against real repositories rather than a mocked runner, because
 * the property that matters is a fact about the repository afterwards: the remote git
 * will actually push to is the remote that was asked for. A mocked runner proves the
 * code called a function.
 */
describe('GitService.setRemote', () => {
  let sandbox: string;
  let repositoryPath: string;
  let firstRemote: string;
  let secondRemote: string;
  let service: GitService;

  const config = () =>
    ({
      git: {
        cloneDepth: 1,
        authorName: 'Cartenz',
        authorEmail: 'agent@example.invalid',
        // file:// remotes are what a test can create; production refuses them.
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
    sandbox = await mkdtemp(join(tmpdir(), 'linkederp-set-remote-'));
    repositoryPath = join(sandbox, 'addons');
    firstRemote = join(sandbox, 'first.git');
    secondRemote = join(sandbox, 'second.git');

    await run('git', ['init', '--bare', '--initial-branch=main', firstRemote]);
    await run('git', ['init', '--bare', '--initial-branch=main', secondRemote]);
    await run('git', ['init', '--initial-branch=main', repositoryPath]);
    await writeFile(join(repositoryPath, '.gitkeep'), '', 'utf8');
    await git(repositoryPath, 'add', '.');
    await git(repositoryPath, 'commit', '-m', 'Scaffold guitartuna');

    service = new GitService(new CommandRunner(config()), config());
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it('gives a repository with no origin one it can push to', async () => {
    expect(await service.originUrl(repositoryPath)).toBeNull();

    await service.setRemote(repositoryPath, 'origin', `file://${firstRemote}`);

    expect(await service.originUrl(repositoryPath)).toBe(`file://${firstRemote}`);

    // The point of setting it: the commit now arrives at the other end.
    const pushed = await service.push({
      repositoryPath,
      remoteUrl: `file://${firstRemote}`,
      branch: 'main',
      credentialDirectory: sandbox,
      credential: null,
    });
    expect(pushed.pushed).toBe(true);

    const remoteHead = (await run('git', ['rev-parse', 'main'], { cwd: firstRemote })).stdout.trim();
    const local = (await run('git', ['rev-parse', 'HEAD'], { cwd: repositoryPath })).stdout.trim();
    expect(remoteHead).toBe(local);
  });

  it('replaces an existing origin rather than failing on it', async () => {
    await service.setRemote(repositoryPath, 'origin', `file://${firstRemote}`);
    // The second call is what a retried project creation does.
    await service.setRemote(repositoryPath, 'origin', `file://${secondRemote}`);

    expect(await service.originUrl(repositoryPath)).toBe(`file://${secondRemote}`);
  });

  it('refuses a remote URL carrying an embedded credential', async () => {
    // Untrusted input would otherwise be written into the repository's own config,
    // where every later push and every `git remote -v` would read it.
    await expect(
      service.setRemote(repositoryPath, 'origin', 'https://user:ghp_secret@github.com/o/r.git'),
    ).rejects.toThrow(/password|credential/i);

    expect(await service.originUrl(repositoryPath)).toBeNull();
  });
});
