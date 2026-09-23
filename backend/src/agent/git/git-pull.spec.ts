import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { GitPullRefusedError, GitService } from './git.service';
import { CommandRunner } from '../../core/process/command-runner.service';
import type { AppConfig } from '../../core/config/configuration';

const run = promisify(execFile);

/**
 * Pulling a branch into the workspace, fast-forward only.
 *
 * This is the operation the `git_pull` tool performs, and the properties that
 * matter are all about what it does when it *cannot* proceed. A pull that
 * reports success without moving the branch would tell a task its work was up
 * to date when it was not; a pull that resolves a divergence by itself would
 * decide whose work wins, and there is no person in this loop to make that call.
 *
 * These run real git against a real remote, as the on-premise push tests do. A
 * mocked runner would prove the right subcommands were assembled; what has to be
 * true is that a branch actually moves, and that a divergence or an unclean tree
 * is refused with the branch left exactly where it was.
 */
describe('GitService.pullFastForward', () => {
  let sandbox: string;
  let remotePath: string;
  let clonePath: string;
  let otherPath: string;
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

  const head = async (cwd: string) => (await git(cwd, 'rev-parse', 'HEAD')).stdout.trim();

  /** A commit made by the person, arriving in the remote the task pulls from. */
  const commitRemote = async (name: string, content: string) => {
    await writeFile(join(projectPath, name), content, 'utf8');
    await git(projectPath, 'add', '.');
    await git(projectPath, 'commit', '-m', `add ${name}`);
    await git(projectPath, 'push', 'origin', 'Staging');
  };

  let projectPath: string;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'linkederp-git-pull-'));
    remotePath = join(sandbox, 'remote.git');
    projectPath = join(sandbox, 'project');
    clonePath = join(sandbox, 'clone');
    otherPath = join(sandbox, 'other');

    await run('git', ['init', '--bare', '--initial-branch=Staging', remotePath]);
    await run('git', ['init', '--initial-branch=Staging', projectPath]);
    await writeFile(join(projectPath, 'first.txt'), 'first\n', 'utf8');
    await git(projectPath, 'add', '.');
    await git(projectPath, 'commit', '-m', 'first');
    await git(projectPath, 'remote', 'add', 'origin', `file://${remotePath}`);
    await git(projectPath, 'push', 'origin', 'Staging');

    // The task's workspace: a clone of the branch it works on.
    await run('git', ['clone', `file://${remotePath}`, clonePath]);

    service = new GitService(new CommandRunner(config()), config());
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  const pull = async (branch = 'Staging') =>
    service.pullFastForward(clonePath, `file://${remotePath}`, branch, {
      credentialDirectory: sandbox,
      credential: null,
    });

  it('reports up_to_date, and moves nothing, when the remote has nothing new', async () => {
    const before = await head(clonePath);

    const result = await pull();

    expect(result.outcome).toBe('up_to_date');
    expect(result.commits).toBe(0);
    expect(result.before).toBe(before);
    expect(result.after).toBe(before);
    expect(await head(clonePath)).toBe(before);
  });

  it('fast-forwards to the commits the remote gained', async () => {
    const before = await head(clonePath);
    await commitRemote('second.txt', 'second\n');
    await commitRemote('third.txt', 'third\n');
    const remoteTip = await head(projectPath);

    const result = await pull();

    expect(result.outcome).toBe('fast_forwarded');
    expect(result.commits).toBe(2);
    expect(result.before).toBe(before);
    expect(result.after).toBe(remoteTip);
    // The property that matters: the working tree actually moved, to the
    // remote's tip, and the commits are the remote's own.
    expect(await head(clonePath)).toBe(remoteTip);
    expect(result.filesChanged).toBe(2);
  });

  it('refuses a dirty working tree before fetching, leaving the branch alone', async () => {
    const before = await head(clonePath);
    await commitRemote('second.txt', 'second\n');
    await writeFile(join(clonePath, 'first.txt'), 'uncommitted local edit\n', 'utf8');

    await expect(pull()).rejects.toBeInstanceOf(GitPullRefusedError);

    // Refused, and nothing was done: the edit is still there and the branch has
    // not moved. A pull that had fetched first would have left the tree in a
    // state the resumption cannot reason about.
    expect(await head(clonePath)).toBe(before);
    expect((await git(clonePath, 'status', '--porcelain')).stdout).toContain('first.txt');
  });

  it('refuses a diverged branch rather than deciding whose work wins', async () => {
    // Someone else rewrites the remote's history while the task has its own
    // commit: the two no longer share a future.
    await run('git', ['clone', `file://${remotePath}`, otherPath]);
    await writeFile(join(otherPath, 'theirs.txt'), 'theirs\n', 'utf8');
    await git(otherPath, 'add', '.');
    await git(otherPath, 'commit', '--amend', '-m', 'rewritten first');
    await git(otherPath, 'push', '--force', 'origin', 'Staging');

    await writeFile(join(clonePath, 'mine.txt'), 'mine\n', 'utf8');
    await git(clonePath, 'add', '.');
    await git(clonePath, 'commit', '-m', 'mine');
    const before = await head(clonePath);

    await expect(pull()).rejects.toBeInstanceOf(GitPullRefusedError);

    // The branch is left at the task's own commit and the working tree is
    // intact: a person decides how to reconcile this.
    expect(await head(clonePath)).toBe(before);
    expect((await git(clonePath, 'status', '--porcelain')).stdout.trim()).toBe('');
    expect(await head(clonePath)).not.toBe(await head(otherPath));
  });

  it('carries the refusal in words a person can act on', async () => {
    await run('git', ['clone', `file://${remotePath}`, otherPath]);
    await writeFile(join(otherPath, 'theirs.txt'), 'theirs\n', 'utf8');
    await git(otherPath, 'add', '.');
    await git(otherPath, 'commit', '--amend', '-m', 'rewritten first');
    await git(otherPath, 'push', '--force', 'origin', 'Staging');

    await writeFile(join(clonePath, 'mine.txt'), 'mine\n', 'utf8');
    await git(clonePath, 'add', '.');
    await git(clonePath, 'commit', '-m', 'mine');

    const refusal = await pull().catch((error: unknown) => error as GitPullRefusedError);

    expect(refusal).toBeInstanceOf(GitPullRefusedError);
    expect((refusal as GitPullRefusedError).kind).toBe('diverged');
    expect((refusal as GitPullRefusedError).message).toMatch(/diverged|fast-forward/i);
    expect((refusal as GitPullRefusedError).message).toMatch(/person/i);
  });

  it('refuses a remote URL carrying an embedded token', async () => {
    // The URL comes out of a project record or a customer repository config, so
    // it is untrusted input and gets the same validation a clone does.
    await expect(
      service.pullFastForward(
        clonePath,
        'https://user:ghp_secret@github.com/o/r.git',
        'Staging',
        { credentialDirectory: sandbox, credential: null },
      ),
    ).rejects.toThrow(/password|credential/i);
  });

  /**
   * A shallow clone is what the platform actually makes (GIT_CLONE_DEPTH), so
   * the fast-forward has to work against one. It is asserted separately because
   * it fails differently: git cannot fast-forward past the shallow boundary
   * without fetching the missing history, and the fetch here is deliberately not
   * `--depth=1` so that history arrives.
   */
  it('fast-forwards a shallow clone', async () => {
    const shallow = join(sandbox, 'shallow');
    await run('git', ['clone', '--depth=1', `file://${remotePath}`, shallow]);
    const before = await head(shallow);

    await commitRemote('second.txt', 'second\n');
    const remoteTip = await head(projectPath);

    const result = await service.pullFastForward(shallow, `file://${remotePath}`, 'Staging', {
      credentialDirectory: sandbox,
      credential: null,
    });

    expect(result.outcome).toBe('fast_forwarded');
    expect(await head(shallow)).toBe(remoteTip);
    expect(before).not.toBe(remoteTip);
  });
});
