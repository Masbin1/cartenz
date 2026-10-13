import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WorkspaceManager,
  buildAiBranchName,
  taskBranchFor,
  type AllocateWorkspaceInput,
} from './workspace-manager';
import type { AppConfig } from '../../core/config/configuration';
import type { DatabaseService } from '../../core/database/database.service';
import type { GitService } from '../git/git.service';
import type { SecretsProvider } from '../../core/secrets/secrets.provider';

/**
 * A branch name reaches a Git command line and appears in a customer repository,
 * so its construction is worth testing before anything can push one.
 */
describe('buildAiBranchName', () => {
  it('follows the documented format', () => {
    const branch = buildAiBranchName('task_9281', 'Fix the VAT rounding error on invoices');
    expect(branch.startsWith('ai/task_9281-')).toBe(true);
  });

  it('produces the documented example shape', () => {
    // Matches the documented example: ai/task-9281-vat-rounding-fix
    expect(buildAiBranchName('task_9281', 'VAT rounding fix')).toBe(
      'ai/task_9281-vat-rounding-fix',
    );
  });

  it('takes at most five words from the prompt', () => {
    const branch = buildAiBranchName(
      'task_1',
      'one two three four five six seven eight nine ten eleven',
    );
    const description = branch.replace('ai/task_1-', '');
    expect(description.split('-')).toHaveLength(5);
  });

  it('strips anything that is not safe in a branch name', () => {
    const branch = buildAiBranchName(
      'task_2',
      'Add field; rm -rf / && echo "done" $(whoami) `id` ../../escape',
    );
    expect(branch).toMatch(/^[A-Za-z0-9._/-]+$/);
    expect(branch).not.toContain('..');
    expect(branch).not.toContain(';');
    expect(branch).not.toContain('&');
    expect(branch).not.toContain('$');
  });

  it('never produces a name beginning with a hyphen', () => {
    for (const prompt of ['-- delete everything', '---', '- - -']) {
      const branch = buildAiBranchName('task_3', prompt);
      expect(branch.startsWith('ai/task_3')).toBe(true);
      expect(branch.replace('ai/', '').startsWith('-')).toBe(false);
    }
  });

  it('falls back to the reference alone when the prompt yields nothing usable', () => {
    expect(buildAiBranchName('task_4', '!!! ??? ...')).toBe('ai/task_4');
    expect(buildAiBranchName('task_4', '')).toBe('ai/task_4');
    // Words of two characters or fewer carry no meaning in a branch name.
    expect(buildAiBranchName('task_4', 'a an of')).toBe('ai/task_4');
  });

  it('bounds the length of the description', () => {
    const branch = buildAiBranchName('task_5', 'implementation '.repeat(20));
    expect(branch.replace('ai/task_5-', '').length).toBeLessThanOrEqual(48);
  });

  it('sanitises the reference as well as the prompt', () => {
    const branch = buildAiBranchName('task/../9281', 'Add a field');
    expect(branch).not.toContain('..');
  });
});

/**
 * ADR-046: the branch a task works on is the environment's branch, so the commit
 * lands where the person pointed the task. `main` is the exception — the
 * platform never works on `main` directly (ADR-028) — so a main-targeted task
 * keeps a branch of its own.
 */
describe('taskBranchFor', () => {
  it('works on the environment branch directly', () => {
    expect(taskBranchFor('staging', 'task_1', 'Fix the VAT rounding error')).toBe('staging');
    expect(taskBranchFor('development', 'task_1', 'Fix the VAT rounding error')).toBe('development');
    expect(taskBranchFor('feat/thing', 'task_1', 'Fix the VAT rounding error')).toBe('feat/thing');
  });

  it('keeps an AI branch only for main', () => {
    expect(taskBranchFor('main', 'task_9281', 'VAT rounding fix')).toBe(
      'ai/task_9281-vat-rounding-fix',
    );
  });
});

describe('on-premise workspace allocation', () => {
  let sandbox: string;
  let workspaceRoot: string;
  let onPremiseRoot: string;
  let projectPath: string;

  const input = (overrides: Partial<AllocateWorkspaceInput> = {}): AllocateWorkspaceInput => ({
    taskId: 'task-1',
    taskReference: 'task_1',
    projectId: 'project-1',
    repositoryUrl: null,
    defaultBranch: 'main',
    odooVersion: '19.0',
    prompt: 'add field',
    credentialRef: null,
    credentialKind: 'token',
    sshHostKey: null,
    credentialUsername: null,
    executionMode: 'on_premise',
    onPremiseProjectPath: projectPath,
    baseCommit: null,
    ...overrides,
  });

  const manager = (
    overrides: {
      dirty?: boolean;
      odooSourcePaths?: string[];
      extraRoots?: string[];
      retainOnFailure?: boolean;
      /** Status read on a SECOND call (e.g. by `release`), separate from allocation's clean-tree gate. */
      dirtyAtRelease?: boolean;
      commit?: (repositoryPath: string, message: string) => Promise<{ commit: string; filesChanged: number }>;
    } = {},
  ) => {
    const config = {
      workspace: {
        root: workspaceRoot,
        maxBytes: 1,
        maxFiles: 1,
        retainOnFailure: overrides.retainOnFailure ?? false,
      },
      onPremise: {
        root: onPremiseRoot,
        roots: [onPremiseRoot, ...(overrides.extraRoots ?? [])],
        readOnlyPaths: [],
      },
      odooSource: { paths: overrides.odooSourcePaths ?? [] },
    } as unknown as AppConfig;

    let statusCalls = 0;
    // Tracks whether the allocation-time auto-commit (see `allocateOnPremise`)
    // actually cleaned the tree, so a status re-check after a successful commit
    // reports clean rather than repeating the pre-commit answer regardless of
    // what the commit mock did — a prior version of this harness always
    // reported the same canned answer, which let the allocation-time recovery
    // path go untested: every "dirty" case still "worked" only because the gate
    // itself never re-read status after the commit.
    let committedAtAllocation = false;
    const git = {
      revParse: async () => 'abc123def456',
      status: async () => {
        statusCalls += 1;
        if (committedAtAllocation) return { clean: true, entries: [] };
        // The first status() call happens at allocation time (before any
        // recovery commit); `dirtyAtRelease` governs every call from the
        // second onward, falling back to the same `dirty` flag when unset.
        const dirty = statusCalls === 1 ? overrides.dirty : overrides.dirtyAtRelease ?? overrides.dirty;
        return { clean: !dirty, entries: [] };
      },
      checkoutBranch: async () => undefined,
      commit: async (repositoryPath: string, message: string) => {
        const result = overrides.commit
          ? await overrides.commit(repositoryPath, message)
          : { commit: 'f'.repeat(40), filesChanged: 1 };
        // Mirrors real git: a commit that reports filesChanged > 0 actually staged
        // and committed everything `git add --all` found, so the tree it reports
        // on every subsequent `status()` call is genuinely clean. Matched on the
        // allocation-time recovery's own wording (distinct from the release-time
        // one's "failed before committing") rather than a call index, because
        // `autoCommitDirtyWorkingTree` itself calls `status()` once before
        // `commit()`, which shifts the index depending on which call site is
        // exercised. A test that wants to simulate a commit succeeding but not
        // actually cleaning the tree (e.g. a hook) passes filesChanged: 0, which
        // correctly leaves this false.
        if (message.includes('working tree was already dirty') && result.filesChanged > 0) {
          committedAtAllocation = true;
        }
        return result;
      },
      gitCommonDir: async (repositoryPath: string) => join(repositoryPath, '.git'),
    } as unknown as GitService;

    const database = {
      db: {
        insert: () => ({ values: async () => ({}) }),
        update: () => ({ set: () => ({ where: async () => ({}) }) }),
      },
    } as unknown as DatabaseService;

    return new WorkspaceManager(config, database, git, {} as SecretsProvider);
  };

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'linkederp-onprem-'));
    workspaceRoot = join(sandbox, 'runtime');
    onPremiseRoot = join(sandbox, 'linkederp');
    projectPath = join(onPremiseRoot, 'linkederp-vania');
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(join(projectPath, '.git'), { recursive: true });
    await mkdir(join(projectPath, 'models'), { recursive: true });
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it('operates directly on the selected branch, not a separate AI branch', async () => {
    const workspace = await manager().allocate(input());

    expect(workspace.simulated).toBe(false);
    expect(workspace.repositoryPath).toBe(projectPath);
    expect(workspace.branch).toBe('main');
    expect(workspace.baseBranch).toBe('main');
    expect(workspace.baseCommit).toBe('abc123def456');
    expect(workspace.readOnlyRoots).toEqual([]);
  });

  it('releases the metadata directory but never deletes the project directory', async () => {
    const workspaceManager = manager();
    const workspace = await workspaceManager.allocate(input({ taskReference: 'task_2' }));

    const metadataRoot = workspace.root;
    await workspaceManager.release(workspace);

    // The customer's directory survives; the platform's metadata directory does not.
    await expect(stat(projectPath)).resolves.toBeTruthy();
    await expect(stat(metadataRoot)).rejects.toBeTruthy();
  });

  it('auto-commits a dirty working tree on release after a failed task, so the next task is not refused', async () => {
    let committedMessage: string | null = null;
    const workspaceManager = manager({
      // Clean at allocation (the clean-tree gate), dirty by the time release runs
      // (the implementation run wrote files and then failed before `commit`).
      dirty: false,
      dirtyAtRelease: true,
      commit: async (_repositoryPath, message) => {
        committedMessage = message;
        return { commit: 'f'.repeat(40), filesChanged: 3 };
      },
    });
    const workspace = await workspaceManager.allocate(input({ taskReference: 'task_recovery' }));

    await workspaceManager.release(workspace, 'failed');

    expect(committedMessage).not.toBeNull();
    expect(committedMessage).toContain('task_recovery');
    // The customer's directory, and whatever the failed run wrote to it, is never removed.
    await expect(stat(projectPath)).resolves.toBeTruthy();
  });

  it('does not auto-commit a clean working tree on release after a failed task', async () => {
    let commitCalls = 0;
    const workspaceManager = manager({
      dirty: false,
      dirtyAtRelease: false,
      commit: async () => {
        commitCalls += 1;
        return { commit: 'f'.repeat(40), filesChanged: 0 };
      },
    });
    const workspace = await workspaceManager.allocate(input({ taskReference: 'task_clean_fail' }));

    await workspaceManager.release(workspace, 'failed');

    expect(commitCalls).toBe(0);
  });

  it('retaining a failed workspace skips the auto-commit entirely', async () => {
    let commitCalls = 0;
    const workspaceManager = manager({
      dirty: false,
      dirtyAtRelease: true,
      retainOnFailure: true,
      commit: async () => {
        commitCalls += 1;
        return { commit: 'f'.repeat(40), filesChanged: 1 };
      },
    });
    const workspace = await workspaceManager.allocate(input({ taskReference: 'task_retained' }));

    await workspaceManager.release(workspace, 'failed');

    expect(commitCalls).toBe(0);
  });

  it('refuses a project directory outside the configured on-premise root', async () => {
    const outside = join(sandbox, 'elsewhere', 'other');
    await mkdir(join(outside, '.git'), { recursive: true });

    await expect(
      manager().allocate(input({ taskReference: 'task_3', onPremiseProjectPath: outside })),
    ).rejects.toThrow(/outside the configured on-premise root/i);
  });

  it('accepts a project directory under a second configured on-premise root', async () => {
    const secondRoot = join(sandbox, 'second-root');
    const secondProject = join(secondRoot, 'other-project', 'addons');
    await mkdir(join(secondProject, '.git'), { recursive: true });

    const multiRootManager = manager({ extraRoots: [secondRoot] });
    const workspace = await multiRootManager.allocate(
      input({ taskReference: 'task_multi_root', onPremiseProjectPath: secondProject }),
    );

    expect(workspace.repositoryPath).toBe(secondProject);
  });

  it('refuses a directory that is not a git repository', async () => {
    const notGit = join(onPremiseRoot, 'not-a-repo');
    await mkdir(notGit, { recursive: true });

    await expect(
      manager().allocate(input({ taskReference: 'task_4', onPremiseProjectPath: notGit })),
    ).rejects.toThrow(/not a Git repository/i);
  });

  /**
   * ADR-039. A project the operator's create_project provisioned keeps its
   * repository in `addons/` and treats the project directory as a container for
   * `config/`, `data/` and `logs/`. A project row recorded before that was
   * distinguished names the container, so the repository has to be found inside it
   * — otherwise every task on such a project fails at allocation.
   */
  it('takes the repository from addons/ when the selected directory is a provisioned project', async () => {
    const provisioned = join(onPremiseRoot, 'guitartuna');
    await mkdir(join(provisioned, 'addons', '.git'), { recursive: true });
    await mkdir(join(provisioned, 'config'), { recursive: true });

    const workspace = await manager().allocate(
      input({ taskReference: 'task_4b', onPremiseProjectPath: provisioned }),
    );

    expect(workspace.repositoryPath).toBe(join(provisioned, 'addons'));
    expect(workspace.simulated).toBe(false);
  });

  it('auto-commits a dirty working tree found at allocation, instead of refusing the task', async () => {
    let committedMessage: string | null = null;
    const workspace = await manager({
      dirty: true,
      commit: async (_repositoryPath, message) => {
        committedMessage = message;
        return { commit: 'f'.repeat(40), filesChanged: 2 };
      },
    }).allocate(input({ taskReference: 'task_5' }));

    expect(committedMessage).not.toBeNull();
    expect(committedMessage).toContain('working tree was already dirty');
    expect(committedMessage).toContain('task_5');
    expect(workspace.repositoryPath).toBe(projectPath);
  });

  it('refuses a dirty working tree that the auto-commit could not clean', async () => {
    const workspaceManager = manager({
      dirty: true,
      // Mimics a `git commit` that reports success but leaves the tree dirty
      // (e.g. a hook or a race outside this class's control): the re-check
      // after the attempted recovery must still see it and refuse clearly,
      // rather than silently proceeding on a tree that is not actually clean.
      commit: async () => ({ commit: 'f'.repeat(40), filesChanged: 0 }),
    });

    await expect(
      workspaceManager.allocate(input({ taskReference: 'task_5b' })),
    ).rejects.toThrow(/could not be auto-committed/i);
  });

  it('resumes using the saved base commit without re-checking the tree', async () => {
    // A dirty tree is expected on resume (the agent's own changes), so the check
    // is skipped and the saved base commit is reused rather than recomputed.
    const workspace = await manager({ dirty: true }).allocate(
      input({ taskReference: 'task_6', baseCommit: 'saved123' }),
    );

    expect(workspace.branch).toBe('main');
    expect(workspace.baseBranch).toBe('main');
    expect(workspace.baseCommit).toBe('saved123');
  });

  /**
   * ADR-031. The reference used to be derived from the on-premise setting alone,
   * which is why it reached one execution mode. It now comes from the Odoo
   * source configuration, and the prefix is the directory's own name so the
   * model refers to `odoo/addons/...` rather than a host path.
   */
  it('exposes the configured Odoo source as read-only roots', async () => {
    const odooPath = join(sandbox, 'base', 'odoo');
    const enterprisePath = join(sandbox, 'base', 'enterprise');
    await mkdir(odooPath, { recursive: true });
    await mkdir(enterprisePath, { recursive: true });

    const workspace = await manager({
      odooSourcePaths: [odooPath, enterprisePath],
    }).allocate(input({ taskReference: 'task_7' }));

    expect(workspace.readOnlyRoots.map((root) => root.prefix)).toEqual(['odoo', 'enterprise']);
    expect(workspace.readOnlyRoots.map((root) => root.path)).toEqual([odooPath, enterprisePath]);
  });

  it('has no read-only roots when no Odoo source is configured', async () => {
    const workspace = await manager().allocate(input({ taskReference: 'task_8' }));
    expect(workspace.readOnlyRoots).toEqual([]);
  });
});
