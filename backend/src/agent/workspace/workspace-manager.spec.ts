import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceManager, buildAiBranchName, type AllocateWorkspaceInput } from './workspace-manager';
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

describe('on-premise workspace allocation', () => {
  let sandbox: string;
  let workspaceRoot: string;
  let onPremiseRoot: string;
  let projectPath: string;

  const input = (overrides: Partial<AllocateWorkspaceInput> = {}): AllocateWorkspaceInput => ({
    taskId: 'task-1',
    taskReference: 'task_1',
    organizationId: 'org-1',
    projectId: 'project-1',
    repositoryUrl: null,
    defaultBranch: 'main',
    odooVersion: '19.0',
    prompt: 'add field',
    credentialRef: null,
    credentialKind: 'token',
    sshHostKey: null,
    executionMode: 'on_premise',
    onPremiseProjectPath: projectPath,
    baseCommit: null,
    ...overrides,
  });

  const manager = (overrides: { dirty?: boolean } = {}) => {
    const config = {
      workspace: { root: workspaceRoot, maxBytes: 1, maxFiles: 1, retainOnFailure: false },
      onPremise: { root: onPremiseRoot, readOnlyPaths: [] },
    } as unknown as AppConfig;

    const git = {
      revParse: async () => 'abc123def456',
      status: async () => ({ clean: !overrides.dirty, entries: [] }),
      checkoutBranch: async () => undefined,
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

  it('refuses a project directory outside the configured on-premise root', async () => {
    const outside = join(sandbox, 'elsewhere', 'other');
    await mkdir(join(outside, '.git'), { recursive: true });

    await expect(
      manager().allocate(input({ taskReference: 'task_3', onPremiseProjectPath: outside })),
    ).rejects.toThrow(/outside the configured on-premise root/i);
  });

  it('refuses a directory that is not a git repository', async () => {
    const notGit = join(onPremiseRoot, 'not-a-repo');
    await mkdir(notGit, { recursive: true });

    await expect(
      manager().allocate(input({ taskReference: 'task_4', onPremiseProjectPath: notGit })),
    ).rejects.toThrow(/not a Git repository/i);
  });

  it('refuses a dirty working tree so the customer’s changes are never committed', async () => {
    await expect(
      manager({ dirty: true }).allocate(input({ taskReference: 'task_5' })),
    ).rejects.toThrow(/uncommitted changes/i);
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
});
