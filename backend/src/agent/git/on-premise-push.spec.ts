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
 * Pushing an on-premise repository to the remote it already carries (ADR-028).
 *
 * On-premise operates on a directory a person selected rather than on a clone the
 * platform made, so the platform holds no repository URL for it. Until this was
 * implemented the workflow completed the task with "pushing is not yet
 * supported", which meant a person who asked for a push got a commit that never
 * left their machine and a message explaining that this was intended.
 *
 * These run real git against a real local remote. A mocked runner would prove the
 * code calls a function; what has to be true is that a commit made in a selected
 * directory arrives in the remote that directory points at, through the same
 * hardened environment every other git call uses.
 */
describe('on-premise push to the repository own remote', () => {
  let sandbox: string;
  let remotePath: string;
  let projectPath: string;
  let service: GitService;

  const config = (pushEnabled: boolean) =>
    ({
      git: {
        cloneDepth: 1,
        authorName: 'Cartenz',
        authorEmail: 'agent@example.invalid',
        // The remote is a file:// path, which production refuses and tests need.
        allowLocalRemotes: true,
        pushEnabled,
        sshHostKeyPolicy: 'accept-new',
      },
      process: { timeoutMs: 20000, maxTimeoutMs: 30000, maxOutputBytes: 256 * 1024 },
      validation: { enabled: false, runtimes: '' },
    }) as unknown as AppConfig;

  /** git in the sandbox, with an identity so a commit can be made at all. */
  const git = (cwd: string, ...args: string[]) =>
    run('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args], { cwd });

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'linkederp-onprem-push-'));
    remotePath = join(sandbox, 'remote.git');
    projectPath = join(sandbox, 'project');

    await run('git', ['init', '--bare', '--initial-branch=Staging', remotePath]);
    await run('git', ['init', '--initial-branch=Staging', projectPath]);
    await writeFile(join(projectPath, 'first.txt'), 'first\n', 'utf8');
    await git(projectPath, 'add', '.');
    await git(projectPath, 'commit', '-m', 'first');
    await git(projectPath, 'remote', 'add', 'origin', `file://${remotePath}`);
    await git(projectPath, 'push', 'origin', 'Staging');

    service = new GitService(new CommandRunner(config(true)), config(true));
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  const remoteHead = async () => {
    const { stdout } = await run('git', ['rev-parse', 'Staging'], { cwd: remotePath });
    return stdout.trim();
  };

  it('reads the remote out of the repository own config', async () => {
    expect(await service.originUrl(projectPath)).toBe(`file://${remotePath}`);
  });

  it('returns null for a repository with no origin, rather than throwing', async () => {
    const orphan = join(sandbox, 'orphan');
    await run('git', ['init', orphan]);

    expect(await service.originUrl(orphan)).toBeNull();
  });

  it('sends a commit made in the selected directory to that remote', async () => {
    const before = await remoteHead();

    await writeFile(join(projectPath, 'field.py'), 'x = 1\n', 'utf8');
    await git(projectPath, 'add', '.');
    await git(projectPath, 'commit', '-m', 'add field');

    const origin = await service.originUrl(projectPath);
    expect(origin).not.toBeNull();

    const result = await service.push({
      repositoryPath: projectPath,
      remoteUrl: origin as string,
      branch: 'Staging',
      credentialDirectory: sandbox,
      credential: null,
    });

    expect(result.pushed).toBe(true);
    // The property that matters: the remote moved, and moved to what was committed.
    const local = (await run('git', ['rev-parse', 'HEAD'], { cwd: projectPath })).stdout.trim();
    expect(await remoteHead()).toBe(local);
    expect(await remoteHead()).not.toBe(before);
  });

  it('is refused at the process layer when GIT_PUSH_ENABLED is false', async () => {
    // The server-wide guarantee (ADR-021 s1): granting the permission in a project
    // must not be enough to write to a repository when the operator said no.
    const disabled = new GitService(new CommandRunner(config(false)), config(false));

    await expect(
      disabled.push({
        repositoryPath: projectPath,
        remoteUrl: `file://${remotePath}`,
        branch: 'Staging',
        credentialDirectory: sandbox,
        credential: null,
      }),
    ).rejects.toThrow(/disabled/i);
  });

  it('refuses a remote that carries an embedded token', async () => {
    // An on-premise remote comes out of a customer config file, not out of a
    // platform record, so it is untrusted input and gets the same validation.
    await expect(
      service.push({
        repositoryPath: projectPath,
        remoteUrl: 'https://user:ghp_secret@github.com/o/r.git',
        credentialDirectory: sandbox,
        branch: 'Staging',
        credential: null,
      }),
    ).rejects.toThrow(/password|credential/i);
  });

  /**
   * Reading the branch back is what makes a push report true.
   *
   * A push whose branch is already at the remote's tip exits 0 and sends
   * nothing; only the read-back distinguishes it from a delivery. This is the
   * check `git_push` now runs before a task may say its work reached the
   * repository.
   */
  describe('reading a branch back from the remote', () => {
    it('returns the commit the remote branch points at', async () => {
      const remote = await service.remoteBranchCommit(`file://${remotePath}`, 'Staging', {
        credentialDirectory: sandbox,
        credential: null,
      });

      expect(remote).toBe(await remoteHead());
    });

    it('returns null when the branch does not exist there', async () => {
      const missing = await service.remoteBranchCommit(`file://${remotePath}`, 'Never-There', {
        credentialDirectory: sandbox,
        credential: null,
      });

      expect(missing).toBeNull();
    });

    it('tracks a push, so a no-op push and a real one are distinguishable', async () => {
      const origin = await service.originUrl(projectPath);
      const before = await service.remoteBranchCommit(origin as string, 'Staging', {
        credentialDirectory: sandbox,
        credential: null,
      });

      await writeFile(join(projectPath, 'second.txt'), 'second\n', 'utf8');
      await git(projectPath, 'add', '.');
      await git(projectPath, 'commit', '-m', 'second');

      await service.push({
        repositoryPath: projectPath,
        remoteUrl: origin as string,
        branch: 'Staging',
        credentialDirectory: sandbox,
        credential: null,
      });

      const head = (await run('git', ['rev-parse', 'HEAD'], { cwd: projectPath })).stdout.trim();
      const after = await service.remoteBranchCommit(origin as string, 'Staging', {
        credentialDirectory: sandbox,
        credential: null,
      });

      expect(before).not.toBe(after);
      expect(after).toBe(head);
      expect(after).toBe(await remoteHead());
    });
  });
});
