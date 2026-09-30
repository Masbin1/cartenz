import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { WorkspaceManager } from './workspace-manager';
import { GitService } from '../git/git.service';
import { CommandRunner } from '../../core/process/command-runner.service';
import type { AppConfig } from '../../core/config/configuration';
import type { DatabaseService } from '../../core/database/database.service';
import type { SecretsProvider } from '../../core/secrets/secrets.provider';

const run = promisify(execFile);

/**
 * A cancelled task must not keep its branch.
 *
 * Observed on a real deployment: a task on `Staging` was cancelled while its
 * analysis step was running. The run exited without releasing its workspace,
 * so the worktree it had taken out of the project's clone stayed registered,
 * and two days later the next task on `Staging` failed with
 *
 *   fatal: 'Staging' is already checked out at '.../task-<cancelled>/repository'
 *
 * over a task that had long since stopped. Two defects combined:
 *
 *  1. `AgentWorkflow.run` released with the status it held in memory. When
 *     `shouldStop` saw the cancellation it returned without updating that
 *     status, so the release saw `analyzing`, treated the task as unsettled and
 *     kept the workspace.
 *  2. `WorkspaceManager.reclaimOrphans`, the safety net for exactly this, was
 *     called from nowhere, looked only at `allocated` rows, and removed the
 *     directory without unregistering the worktree - which on its own still
 *     leaves the branch pinned.
 *
 * Real git below, because "the branch is free again" is a git behaviour.
 */
describe('a workspace whose task has settled is reclaimed and frees its branch', () => {
  let sandbox: string;
  let remotePath: string;
  let checkoutPath: string;
  let workspaceRoot: string;
  let git: GitService;

  const gitConfig = () =>
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

  const sh = (cwd: string, ...args: string[]) =>
    run('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args], { cwd });

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'linkederp-reclaim-'));
    remotePath = join(sandbox, 'remote.git');
    const seed = join(sandbox, 'seed');
    checkoutPath = join(sandbox, 'checkout');
    workspaceRoot = join(sandbox, 'workspaces');
    await mkdir(workspaceRoot, { recursive: true });

    await run('git', ['init', '--bare', '--initial-branch=Development', remotePath]);
    await run('git', ['clone', `file://${remotePath}`, seed]);
    await writeFile(join(seed, 'a.txt'), 'a\n', 'utf8');
    await sh(seed, 'add', '.');
    await sh(seed, 'commit', '-m', 'a');
    await sh(seed, 'push', 'origin', 'Development');
    await sh(seed, 'checkout', '-b', 'Staging');
    await sh(seed, 'push', 'origin', 'Staging');

    // The project's clone as ADR-063 keeps it: every branch, nothing checked out.
    await run('git', ['clone', '--no-checkout', `file://${remotePath}`, checkoutPath]);
    await sh(checkoutPath, 'checkout', '--detach', 'origin/Development');
    await sh(checkoutPath, 'branch', 'Staging', 'origin/Staging');

    git = new GitService(new CommandRunner(gitConfig()), gitConfig());
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  /**
   * A database that answers the reclaim's one select with the given rows and
   * records every status written back.
   */
  const fakeDatabase = (
    rows: Array<{
      workspaceRef: string;
      rootPath: string;
      baseCommit: string | null;
      status: string;
      taskStatus: string;
    }>,
  ) => {
    const writes: Array<{ status: string }> = [];
    const database = {
      db: {
        select: () => ({
          from: () => ({
            innerJoin: () => ({
              where: async () => rows,
            }),
          }),
        }),
        update: () => ({
          set: (values: { status: string }) => ({
            where: async () => {
              writes.push(values);
            },
          }),
        }),
      },
    } as unknown as DatabaseService;
    return { database, writes };
  };

  const manager = (database: DatabaseService) =>
    new WorkspaceManager(
      {
        workspace: { root: workspaceRoot, maxBytes: 1 << 30, maxFiles: 1 << 20, retainOnFailure: false },
        onPremise: { root: null, readOnlyPaths: [] },
        odooSource: { paths: [] },
        checkouts: { root: null, reuse: true },
      } as unknown as AppConfig,
      database,
      git,
      {} as SecretsProvider,
    );

  const holdStagingInAWorkspace = async (name: string) => {
    const root = join(workspaceRoot, name);
    await mkdir(join(root, 'metadata'), { recursive: true });
    await git.worktreeAttach(checkoutPath, join(root, 'repository'), 'Staging');
    return root;
  };

  it('frees the branch the leaked worktree was holding', async () => {
    const root = await holdStagingInAWorkspace('task-task_423974-ws-5994750e');

    // The state that failed the next task: git refuses Staging.
    await expect(
      git.worktreeAttach(checkoutPath, join(sandbox, 'next-task'), 'Staging'),
    ).rejects.toThrow(/already (checked out|used by worktree)/);

    const { database, writes } = fakeDatabase([
      {
        workspaceRef: 'ws-5994750e',
        rootPath: root,
        baseCommit: null,
        status: 'ready',
        taskStatus: 'cancelled',
      },
    ]);

    await expect(manager(database).reclaimOrphans()).resolves.toBe(1);

    // Directory gone, row marked released, and - the point - no worktree entry
    // left pinning Staging.
    await expect(stat(root)).rejects.toThrow();
    expect(writes.map((write) => write.status)).toEqual(['released']);
    expect((await git.worktreeBranches(checkoutPath)).has('Staging')).toBe(false);

    await expect(
      git.worktreeAttach(checkoutPath, join(sandbox, 'next-task'), 'Staging'),
    ).resolves.toBeUndefined();
  });

  it('leaves a row outside the workspace root alone', async () => {
    const outside = join(sandbox, 'somewhere-else');
    await mkdir(outside, { recursive: true });

    const { database, writes } = fakeDatabase([
      {
        workspaceRef: 'ws-outside',
        rootPath: outside,
        baseCommit: null,
        status: 'ready',
        taskStatus: 'cancelled',
      },
    ]);

    await expect(manager(database).reclaimOrphans()).resolves.toBe(0);
    await expect(stat(outside)).resolves.toBeDefined();
    expect(writes).toEqual([]);
  });
});

/**
 * The sources are read for the two properties no unit test here can drive
 * without constructing a whole queue job: that the workflow releases with the
 * status the task actually ended at, and that the worker really calls the
 * reclaim.
 */
describe('the release and the reclaim are both wired', () => {
  const source = (relative: string) => readFile(join(__dirname, '..', '..', relative), 'utf8');

  it('releases with the status re-read from the database, not the in-memory snapshot', async () => {
    const workflow = await source('agent/orchestration/agent-workflow.ts');
    const runBody = workflow.slice(
      workflow.indexOf('async run(taskId: string)'),
      workflow.indexOf('private async step('),
    );
    expect(runBody).toMatch(/this\.tasks\.currentStatus\(taskId\)/);
    expect(runBody).toMatch(/releaseWorkspace\(taskId, finalStatus\)/);
    expect(runBody).not.toMatch(/releaseWorkspace\(taskId, snapshot\.status\)/);
  });

  it('only reclaims workspaces of settled tasks, and unregisters the worktree', async () => {
    const manager = await source('agent/workspace/workspace-manager.ts');
    const body = manager.slice(manager.indexOf('async reclaimOrphans()'));
    expect(body).toMatch(/inArray\(agentTasks\.status, \[\.\.\.TERMINAL_TASK_STATUSES\]\)/);
    expect(body).toMatch(/owningClone\(/);
    expect(body).toMatch(/unregisterWorktree\(/);
    // Ordering: the owning clone is read from the worktree before it is removed.
    expect(body.indexOf('owningClone(')).toBeLessThan(body.indexOf('await rm('));
  });

  it('is called by the worker at boot and on an interval', async () => {
    const worker = await source('worker.ts');
    expect(worker).toMatch(/reclaimOrphans\(\)/);
    expect(worker).toMatch(/void reclaim\(\);/);
    expect(worker).toMatch(/setInterval\(\(\) => void reclaim\(\), WORKSPACE_RECLAIM_INTERVAL_MS\)/);
  });
});
