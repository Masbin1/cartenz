# Local Execution Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `on_premise` and `odoo_sh` projects live at a persistent local path under a configured `PROJECTS_ROOT`, be edited in place, validated through the existing ADR-027 runner, and pushed with a real `git_push` (when `GIT_PUSH_ENABLED=true`), plus configure Hermes as a local model gateway.

**Architecture:** Add a `PROJECTS_ROOT` config and a `localPath` column; resolve `localPath` through a new `resolveLocalPath` containment helper; teach `WorkspaceManager` a persistent strategy (`repositoryPath` = the project's own directory, metadata/logs stay in the per-task scratch root); make `git_push` real behind the existing process gate; reuse `OdooValidationRunner` for "run"; add a Hermes preset and a 3-type project wizard.

**Tech Stack:** NestJS 10, Next.js 15 / React 19, PostgreSQL + Drizzle ORM, Redis + BullMQ, TypeScript, Jest.

**Spec:** `docs/superpowers/specs/2026-08-31-local-execution-mode-design.md`

## Global Constraints

- **Path containment** (`backend/src/agent/workspace/workspace-path.ts`): every filesystem path is resolved via realpath and must stay inside its root. The new `localPath` is an *absolute* path, so it gets its own helper (`resolveLocalPath`) — it must **not** be passed through `resolveExistingPath`/`resolveWritablePath`, which reject absolute paths by design.
- **Push safety (ADR-021):** `git push` is refused at the process layer unless `GIT_PUSH_ENABLED=true`. Production environments (`kind === 'production'`) are never targetable; a task cannot target production, and this plan does not weaken that.
- **No shell:** all process work goes through `CommandRunner.run` with argument vectors; the allowlist is `git` (guarded) and `python3`→`odoo-bin` (guarded by `VALIDATION_ENABLED` + `assertOdooInvocation`).
- **Data-blind:** no credential plaintext is held anywhere outside `SecretsProvider`; never return or log a key.

---

### Task 1: `PROJECTS_ROOT` configuration

**Files:**
- Modify: `backend/src/core/config/configuration.ts` (schema `environmentSchema`, `AppConfig.workspace`, `loadConfig`)
- Modify: `.env.example`
- Test: `backend/src/core/config/configuration.spec.ts` (create if absent)

**Interfaces:**
- Consumes: `process.env.PROJECTS_ROOT`
- Produces: `config.workspace.projectsRoot: string` (default `/home/masbintang/linkederp`)

- [ ] **Step 1: Add `PROJECTS_ROOT` to the zod schema**

In `environmentSchema`, after the `WORKSPACE_RETAIN_ON_FAILURE` entry (line ~100):

```ts
  /**
   * Where local projects live on this host (local execution mode). A project's
   * localPath must resolve inside this root; it is the containment boundary for
   * the persistent workspace strategy, separate from WORKSPACE_ROOT, which holds
   * per-task scratch metadata and logs.
   */
  PROJECTS_ROOT: z.string().min(1).default('/home/masbintang/linkederp'),
```

- [ ] **Step 2: Add it to `AppConfig.workspace` and `loadConfig`**

```ts
  readonly workspace: {
    readonly root: string;
    readonly projectsRoot: string;
    readonly maxBytes: number;
    readonly maxFiles: number;
    readonly retainOnFailure: boolean;
  };
```

And in the returned object of `loadConfig`:

```ts
    workspace: {
      root: env.WORKSPACE_ROOT,
      projectsRoot: env.PROJECTS_ROOT,
      maxBytes: env.WORKSPACE_MAX_BYTES,
      ...
    },
```

- [ ] **Step 3: Write the failing test**

`backend/src/core/config/configuration.spec.ts`:

```ts
import { loadConfig } from './configuration';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'a'.repeat(32),
  SECRETS_ROOT_KEY: 'b'.repeat(64),
};

describe('loadConfig', () => {
  it('defaults PROJECTS_ROOT to /home/masbintang/linkederp', () => {
    expect(loadConfig({ ...base }).workspace.projectsRoot).toBe('/home/masbintang/linkederp');
  });

  it('reads PROJECTS_ROOT from the environment', () => {
    expect(loadConfig({ ...base, PROJECTS_ROOT: '/srv/odoo/projects' }).workspace.projectsRoot).toBe(
      '/srv/odoo/projects',
    );
  });
});
```

- [ ] **Step 4: Run it**

Run: `npm test --workspace backend -- src/core/config/configuration.spec.ts`
Expected: PASS.

- [ ] **Step 5: Document in `.env.example`**

Add a new section after the Workspaces block:

```bash
# -----------------------------------------------------------------------------
# Local execution mode
# -----------------------------------------------------------------------------
# Root under which on-premise addons directories and odoo_sh clone directories
# live. A project's localPath must resolve inside this root.
PROJECTS_ROOT=/home/masbintang/linkederp
```

- [ ] **Step 6: Commit**

```bash
git add backend/src/core/config/configuration.ts backend/src/core/config/configuration.spec.ts .env.example
git commit -m "feat(config): add PROJECTS_ROOT for local execution mode"
```

---

### Task 2: `localPath` column on `projects`

**Files:**
- Modify: `backend/src/core/database/schema.ts` (add `localPath` to the `projects` table, after `repositoryUrl` at line ~197)
- Create: next migration via `npm run db:generate`

**Interfaces:**
- Produces: `projects.localPath: string | null`

- [ ] **Step 1: Add the column**

```ts
    repositoryUrl: text('repository_url'),
    localPath: text('local_path'),
```

- [ ] **Step 2: Generate the migration**

Run: `npm run db:generate`
Expected: a new migration in `backend/drizzle/` adding `local_path text`.

- [ ] **Step 3: Run the migration**

Run: `npm run db:migrate` (or the equivalent per `RUNNING.md`).

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/core/database/schema.ts backend/drizzle/
git commit -m "feat(schema): add localPath column to projects"
```

---

### Task 3: `resolveLocalPath` containment helper

**Files:**
- Modify: `backend/src/agent/workspace/workspace-path.ts`
- Test: `backend/src/agent/workspace/workspace-path.spec.ts` (create if absent)

**Interfaces:**
- Consumes: `realpath`, `resolve`, `isAbsolute`, `isInside`, `PathEscapeError` (already in the file)
- Produces: `resolveLocalPath(root: string, absolutePath: string): Promise<string>`

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtemp, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveLocalPath } from './workspace-path';

describe('resolveLocalPath', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'projects-root-'));
  });

  it('resolves an existing directory inside the root', async () => {
    const addons = join(root, 'my_addons');
    await mkdir(addons, { recursive: true });
    await expect(resolveLocalPath(root, addons)).resolves.toBe(await realpath(addons));
  });

  it('resolves a not-yet-existing directory inside the root', async () => {
    await expect(resolveLocalPath(root, join(root, 'new_clone'))).resolves.toBe(
      join(await realpath(root), 'new_clone'),
    );
  });

  it('refuses a path outside the root', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'outside-'));
    await expect(resolveLocalPath(root, outside)).rejects.toThrow(/outside the configured projects root/);
  });

  it('refuses a relative path', async () => {
    await expect(resolveLocalPath(root, 'relative/path')).rejects.toThrow(/absolute/);
  });
});
```

- [ ] **Step 2: Run it to confirm failure**

Run: `npm test --workspace backend -- src/agent/workspace/workspace-path.spec.ts`
Expected: FAIL (`resolveLocalPath` is not defined).

- [ ] **Step 3: Implement it (append to `workspace-path.ts`)**

```ts
/**
 * Validates an absolute project directory against a configured root, for local
 * execution mode. Unlike the tool helpers above, the input is absolute — a
 * localPath comes from project configuration, not from the agent — and the final
 * segment may not exist yet (an odoo_sh clone target). The nearest existing
 * ancestor is resolved and must be inside the root.
 */
export async function resolveLocalPath(root: string, absolutePath: string): Promise<string> {
  if (typeof absolutePath !== 'string' || absolutePath.length === 0 || !isAbsolute(absolutePath)) {
    throw new PathEscapeError(String(absolutePath), 'it is not an absolute path');
  }

  const realRoot = await realpath(resolve(root));

  let ancestor = absolutePath;
  let realAncestor: string | null = null;
  while (realAncestor === null) {
    const parent = resolve(ancestor, '..');
    if (parent === ancestor) break;
    try {
      realAncestor = await realpath(parent);
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') throw error;
      ancestor = parent;
    }
  }

  if (realAncestor === null || !isInside(realRoot, realAncestor)) {
    throw new PathEscapeError(absolutePath, 'it is outside the configured projects root');
  }

  return resolve(absolutePath);
}
```

- [ ] **Step 4: Run it to confirm pass**

Run: `npm test --workspace backend -- src/agent/workspace/workspace-path.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/agent/workspace/workspace-path.ts backend/src/agent/workspace/workspace-path.spec.ts
git commit -m "feat(workspace): add resolveLocalPath containment helper"
```

---

### Task 4: `GitService.isRepository`, `checkout`, and `push`

**Files:**
- Modify: `backend/src/agent/git/git.service.ts`
- Test: `backend/src/agent/git/git.service.spec.ts`

**Interfaces:**
- Consumes: `CommandRunner`, `APP_CONFIG`, `SECRETS_PROVIDER` (new injection), `leaseGitCredential` (already imported)
- Produces:
  - `isRepository(repositoryPath: string): Promise<boolean>`
  - `checkout(repositoryPath: string, ref: string): Promise<void>`
  - `push(repositoryPath, remote, branch, options?): Promise<{ pushed: boolean; remote: string; branch: string }>`

- [ ] **Step 1: Inject `SecretsProvider`**

Add the import and constructor parameter:

```ts
import { SECRETS_PROVIDER, type SecretsProvider } from '../../core/secrets/secrets.provider';

constructor(
  private readonly commands: CommandRunner,
  @Inject(APP_CONFIG) private readonly config: AppConfig,
  @Inject(SECRETS_PROVIDER) private readonly secrets: SecretsProvider,
) {}
```

- [ ] **Step 2: Extend `run` to carry an `env`**

```ts
  private run(
    repositoryPath: string,
    args: readonly string[],
    options: { stdin?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
  ): Promise<CommandResult> {
    return this.commands.run('git', [...HARDENING_ARGS, ...args], {
      cwd: repositoryPath,
      stdin: options.stdin,
      timeoutMs: options.timeoutMs,
      env: options.env,
    });
  }
```

- [ ] **Step 3: Add `isRepository` and `checkout`**

```ts
  /** True when the path is a git working tree. */
  async isRepository(repositoryPath: string): Promise<boolean> {
    const result = await this.run(repositoryPath, ['rev-parse', '--is-inside-work-tree']);
    return result.exitCode === 0 && result.stdout.trim() === 'true';
  }

  /** Checks out an existing ref. */
  async checkout(repositoryPath: string, ref: string): Promise<void> {
    const branch = assertSafeRefName(ref);
    const result = await this.run(repositoryPath, ['checkout', branch, '--']);
    if (result.exitCode !== 0) {
      throw new GitCommandError(`checkout ${branch}`, result.exitCode, summariseFailure(result));
    }
  }
```

- [ ] **Step 4: Add `push` (mirrors `clone`'s credential lease)**

```ts
  /**
   * Pushes the branch to the remote (ADR-021). Mirrors clone's credential lease:
   * a token or SSH key is read from the secrets provider only at the moment of
   * the push, the helper is written outside the repository, and it is released
   * in a finally. The process layer refuses the subcommand unless
   * GIT_PUSH_ENABLED is true.
   */
  async push(
    repositoryPath: string,
    remote: string,
    branch: string,
    options: {
      credentialRef?: string | null;
      credentialKind?: 'token' | 'ssh_key';
      sshHostKey?: string | null;
      credentialDirectory?: string;
    } = {},
  ): Promise<{ pushed: boolean; remote: string; branch: string }> {
    const credential = options.credentialRef
      ? {
          kind: options.credentialKind ?? 'token',
          value: await this.secrets.read(options.credentialRef),
          hostKey: options.sshHostKey ?? null,
        }
      : null;

    const lease = await leaseGitCredential({
      directory: options.credentialDirectory ?? join(repositoryPath, '.credential-lease'),
      credential,
      hostKeyPolicy: this.config.git.sshHostKeyPolicy,
    });

    try {
      const result = await this.run(repositoryPath, ['push', remote, branch], { env: lease.env });
      if (result.exitCode !== 0) {
        throw new GitCommandError(`push ${remote} ${branch}`, result.exitCode, summariseFailure(result));
      }
      return { pushed: true, remote, branch };
    } finally {
      await lease.release();
    }
  }
```

(`join` is not yet imported in `git.service.ts` — add it to the `node:path` import at the top.)

- [ ] **Step 5: Write the test (add to `git.service.spec.ts`)**

Update existing `GitService` constructor calls to pass a `secrets` mock, then:

```ts
it('push runs git push through CommandRunner', async () => {
  const result = await service.push('/repo', 'origin', 'ai/task-1');
  expect(commands.run).toHaveBeenCalledWith(
    'git',
    expect.arrayContaining(['push', 'origin', 'ai/task-1']),
    expect.objectContaining({ cwd: '/repo' }),
  );
  expect(result.pushed).toBe(true);
});
```

- [ ] **Step 6: Run it**

Run: `npm test --workspace backend -- src/agent/git/git.service.spec.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/agent/git/git.service.ts backend/src/agent/git/git.service.spec.ts
git commit -m "feat(git): add isRepository, checkout and push to GitService"
```

---

### Task 5: `localPath` validation on project creation

**Files:**
- Create: `backend/src/modules/projects/local-path.ts`
- Create: `backend/src/modules/projects/local-path.spec.ts`
- Modify: `backend/src/modules/projects/dto/project.dto.ts`
- Modify: `backend/src/modules/projects/projects.service.ts`

**Interfaces:**
- Consumes: `resolveLocalPath`, `AppConfig.workspace.projectsRoot`
- Produces: `resolveProjectLocalPath(projectsRoot, projectType, localPath): Promise<string | null>`

- [ ] **Step 1: Write the failing test**

`backend/src/modules/projects/local-path.spec.ts`:

```ts
import { mkdtemp, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveProjectLocalPath } from './local-path';

describe('resolveProjectLocalPath', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'projects-root-'));
  });

  it('requires a localPath for on_premise', async () => {
    await expect(resolveProjectLocalPath(root, 'on_premise', undefined)).rejects.toThrow('localPath');
  });

  it('resolves an addons directory inside the root', async () => {
    const addons = join(root, 'my_addons');
    await mkdir(addons, { recursive: true });
    await expect(resolveProjectLocalPath(root, 'on_premise', addons)).resolves.toBe(
      await realpath(addons),
    );
  });

  it('refuses a path outside the root', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'outside-'));
    await expect(resolveProjectLocalPath(root, 'on_premise', outside)).rejects.toThrow(/outside/);
  });

  it('returns null for a repository project with no localPath', async () => {
    await expect(resolveProjectLocalPath(root, 'repository', undefined)).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: Run it to confirm failure**

Run: `npm test --workspace backend -- src/modules/projects/local-path.spec.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `local-path.ts`**

```ts
import { BadRequestException } from '@nestjs/common';
import { PathEscapeError, resolveLocalPath } from '../../agent/workspace/workspace-path';

/**
 * Resolves and validates a project's localPath for its type.
 *
 * `on_premise` requires an addons directory (which must exist inside the root).
 * `odoo_sh` may declare one; when it does it is the stable clone directory and
 * may not exist yet. Every other type has no localPath.
 */
export async function resolveProjectLocalPath(
  projectsRoot: string,
  projectType: string,
  localPath: string | undefined,
): Promise<string | null> {
  if (projectType === 'on_premise') {
    if (!localPath || localPath.trim().length === 0) {
      throw new BadRequestException('An on-premise project needs an addons directory path (localPath).');
    }
  } else if (projectType === 'odoo_sh') {
    if (!localPath || localPath.trim().length === 0) return null;
  } else {
    return null;
  }

  try {
    return await resolveLocalPath(projectsRoot, localPath!.trim());
  } catch (error) {
    if (error instanceof PathEscapeError) throw new BadRequestException(error.message);
    throw error;
  }
}
```

- [ ] **Step 4: Add `localPath` to `CreateProjectDto`**

In `project.dto.ts`, add to `CreateProjectDto`:

```ts
  @IsOptional()
  @IsString()
  localPath?: string;
```

- [ ] **Step 5: Wire into `ProjectsService.create`**

In `create()` (after the `repositoryUrl` validation, before `insertProject`):

```ts
    const localPath = await resolveProjectLocalPath(
      this.config.workspace.projectsRoot,
      dto.projectType,
      dto.localPath,
    );
```

Pass it through `insertProject` (add `localPath: string | null` to the values type and to `values({ ... })`), and add `localPath` to the `present()` return shape and its parameter type.

- [ ] **Step 6: Run it**

Run: `npm test --workspace backend -- src/modules/projects/local-path.spec.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/modules/projects/local-path.ts backend/src/modules/projects/local-path.spec.ts backend/src/modules/projects/dto/project.dto.ts backend/src/modules/projects/projects.service.ts
git commit -m "feat(projects): validate and store localPath on project creation"
```

---

### Task 6: Persistent workspace strategy in `WorkspaceManager`

**Files:**
- Modify: `backend/src/agent/workspace/workspace-manager.ts`
- Test: `backend/src/agent/workspace/workspace-manager.spec.ts`

**Interfaces:**
- Consumes: `resolveLocalPath`, `config.workspace.projectsRoot`, `git.isRepository`/`checkout`/`clone`/`createBranch`/`revParse`
- Produces: `AllocateWorkspaceInput.localPath: string | null`; `Workspace` with `repositoryPath` set to the project directory for local projects, `simulated: false`.

- [ ] **Step 1: Add `localPath` to `AllocateWorkspaceInput`**

```ts
  /** The project's persistent local directory, for local execution mode. */
  readonly localPath: string | null;
```

- [ ] **Step 2: Resolve and branch in `allocate`**

Immediately after computing `workspaceId`/`root`/`metadataPath`/`logsPath`/`branch`, add:

```ts
    const repositoryPath = input.localPath
      ? await resolveLocalPath(this.config.workspace.projectsRoot, input.localPath)
      : join(root, 'repository');
```

Change the existing `const repositoryPath = join(root, 'repository');` line to the above.

Then read the credential before the branch (move the existing `const credential = ...` block up, out of the `if (!input.repositoryUrl)` guard), and after `mkdir(logsPath)` / the `agentWorkspaces` insert, add the local branch **before** the existing `if (!input.repositoryUrl)` block:

```ts
    if (input.localPath) {
      let baseCommit: string | null = null;
      if (input.repositoryUrl) {
        // odoo_sh: clone once into the stable directory, then create the AI branch.
        if (!(await this.git.isRepository(repositoryPath))) {
          const credential = input.credentialRef
            ? { kind: input.credentialKind, value: await this.secrets.read(input.credentialRef), hostKey: input.sshHostKey }
            : null;
          await this.git.clone({
            remoteUrl: input.repositoryUrl,
            branch: input.defaultBranch,
            destination: repositoryPath,
            credentialDirectory: metadataPath,
            credential,
          });
        } else {
          await this.git.checkout(repositoryPath, input.defaultBranch);
        }
        await this.git.createBranch(repositoryPath, branch);
        baseCommit = await this.git.revParse(repositoryPath, 'HEAD');
      } else {
        // on_premise: edit the existing addons directory in place, on the current
        // branch (no clone, no AI branch). baseCommit is HEAD when it is a git repo.
        baseCommit = await this.git.revParse(repositoryPath, 'HEAD').catch(() => null);
      }

      await this.markStatus(workspaceId, 'ready', baseCommit, 0, 0);
      this.logger.log(`Workspace ${workspaceId} ready on local path ${repositoryPath}`);

      return {
        workspaceId,
        taskReference: input.taskReference,
        root,
        repositoryPath,
        metadataPath,
        logsPath,
        branch: input.repositoryUrl ? branch : input.defaultBranch,
        baseBranch: input.defaultBranch,
        baseCommit,
        repositoryUrl: input.repositoryUrl,
        odooVersion: input.odooVersion,
        simulated: false,
        learnedHostKey: null,
      };
    }
```

Notes for the executor:
- The quota check (`assertWithinQuota`) must **not** run for local workspaces: a local directory is the operator's own, not platform disk.
- `release()` needs **no change**: it removes `workspace.root` (the per-task scratch dir). For a local workspace, `repositoryPath` lives outside `root`, so it is preserved. Add a test asserting this.

- [ ] **Step 3: Write the failing test**

In `workspace-manager.spec.ts`, using the existing mock harness (`database`, `git`, `secrets`):

```ts
it('allocates a persistent local workspace without cloning and release keeps it', async () => {
  const localDir = join(tempProjectsRoot, 'addons');
  await mkdir(localDir, { recursive: true });
  git.revParse.mockResolvedValue('abc1234');

  const workspace = await manager.allocate({
    taskId: 'task-1',
    taskReference: 'task_1',
    organizationId: 'org-1',
    projectId: 'proj-1',
    repositoryUrl: null,
    localPath: localDir,
    defaultBranch: 'main',
    odooVersion: '18.0',
    prompt: 'add a field',
    credentialRef: null,
    credentialKind: 'token',
    sshHostKey: null,
  });

  expect(workspace.repositoryPath).toBe(localDir);
  expect(workspace.simulated).toBe(false);

  await manager.release(workspace, 'completed');
  expect(existsSync(localDir)).toBe(true);
});
```

- [ ] **Step 4: Run it to confirm failure, then pass**

Run: `npm test --workspace backend -- src/agent/workspace/workspace-manager.spec.ts`
Expected: FAIL before Step 2 is applied, PASS after.

- [ ] **Step 5: Commit**

```bash
git add backend/src/agent/workspace/workspace-manager.ts backend/src/agent/workspace/workspace-manager.spec.ts
git commit -m "feat(workspace): persistent local workspace strategy"
```

---

### Task 7: Real `git_push` + workflow wiring

**Files:**
- Modify: `backend/src/agent/task-repository.ts`
- Modify: `backend/src/agent/orchestration/agent-workflow.ts`
- Modify: `backend/src/agent/tools/tool.interface.ts`
- Modify: `backend/src/agent/tools/real/git.tools.ts`

**Interfaces:**
- Consumes: `ToolExecutionContext.workspace` (extended with `metadataPath`, `credentialRef`, `credentialKind`, `sshHostKey`); `config.git.pushEnabled`
- Produces: real `git_push` execution; workflow passes `localPath` and the extended context.

- [ ] **Step 1: Add `localPath` to the snapshot**

In `task-repository.ts`:
- Add `readonly localPath: string | null;` to `TaskExecutionSnapshot`.
- Add `localPath: projects.localPath,` to the `snapshot()` select.
- Add `localPath: row.localPath,` to the returned object.

- [ ] **Step 2: Extend `ToolExecutionContext.workspace`**

In `tool.interface.ts`, add to the `workspace` shape:

```ts
    readonly metadataPath: string;
    readonly credentialRef: string | null;
    readonly credentialKind: 'token' | 'ssh_key' | null;
    readonly sshHostKey: string | null;
```

And add `metadataPath`, `credentialRef`, `credentialKind`, `sshHostKey` to the `Workspace` interface in `workspace-manager.ts` (populate from `allocate`'s input/derived values), so `callTool` can copy them through.

- [ ] **Step 3: Make `gitPush` real**

In `git.tools.ts`:
- Import `APP_CONFIG` / `AppConfig`.
- Change the constructor to `constructor(private readonly git: GitService, @Inject(APP_CONFIG) private readonly config: AppConfig) {}`.
- Replace the `gitPush` definition:

```ts
  private readonly gitPush: ToolDefinition<Record<string, never>> = {
    name: 'git_push',
    description: 'Push the task branch to the connected repository',
    permission: 'git_push',
    leavesPlatform: true,
    simulated: false,
    parameters: NO_ARGUMENTS_SCHEMA,
    availableToModel: false,
    validate: requireObject,
    execute: async (_input, context) => {
      if (!this.config.git.pushEnabled) {
        return {
          branch: context.workspace.branch,
          remote: context.workspace.repositoryUrl,
          pushed: false,
          note: 'Pushing is disabled on this server (GIT_PUSH_ENABLED=false); the branch stays in the workspace.',
          simulated: true,
        };
      }
      assertRepository(context);
      const result = await this.git.push(
        context.workspace.repositoryPath,
        'origin',
        context.workspace.branch,
        {
          credentialRef: context.workspace.credentialRef,
          credentialKind: context.workspace.credentialKind ?? 'token',
          sshHostKey: context.workspace.sshHostKey,
          credentialDirectory: context.workspace.metadataPath,
        },
      );
      return { branch: context.workspace.branch, remote: result.remote, pushed: true };
    },
  };
```

- [ ] **Step 4: Wire the workflow**

In `agent-workflow.ts`:
1. In `acquireWorkspace`, add `localPath: snapshot.localPath,` to the `workspaceManager.allocate({...})` call.
2. In `callTool`, extend the `workspace` object with `metadataPath: workspace.metadataPath`, `credentialRef: workspace.credentialRef`, `credentialKind: workspace.credentialKind`, `sshHostKey: workspace.sshHostKey`.
3. In `push()`, replace the simulated narration/transition with a real one:

```ts
  private async push(snapshot: TaskExecutionSnapshot): Promise<boolean> {
    const workspace = await this.acquireWorkspace(snapshot);
    const result = await this.callTool(snapshot, workspace, 'git_push', {});

    if (result.status === 'suspended') return false;
    if (result.status !== 'succeeded') {
      return this.tasks.transition(snapshot.taskId, 'pushing', 'failed', {
        failureReason: 'The push did not complete.',
      });
    }

    await this.narrate(snapshot, `Pushed ${workspace.branch} to the remote.`);

    return this.tasks.transition(snapshot.taskId, 'pushing', 'completed', {
      message: `Branch ${workspace.branch} was pushed to the repository.`,
    });
  }
```

4. In `analyze()`, the narration at lines ~248-254 assumes a clone. Adjust it to handle the local case: when the workspace is local (`workspace.repositoryPath` is the project path), narrate `Opened ${workspace.baseBranch} at ${workspace.baseCommit} and created ${workspace.branch}` (or omit "created" for on-premise). Keep the change minimal and accurate for both `odoo_sh` and `on_premise`.

- [ ] **Step 5: Note the behaviour change**

`ToolRegistry.simulatedCapabilities()` no longer reports `push` as simulated (the tool is now `simulated: false`). The portal already shows `git.pushEnabled` from `/agent/capabilities`, which is the authoritative signal. Update any unit test that asserted `'push' ∈ simulatedCapabilities()`.

- [ ] **Step 6: Run typecheck and tests**

Run: `npm run typecheck && npm test --workspace backend`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/agent/task-repository.ts backend/src/agent/orchestration/agent-workflow.ts backend/src/agent/tools/tool.interface.ts backend/src/agent/tools/real/git.tools.ts backend/src/agent/tools/tool-registry.ts
git commit -m "feat(tools): make git_push real and wire localPath through the workflow"
```

---

### Task 8: Align "run" with the existing validation runner

**Files:**
- Modify: `backend/src/agent/validation/odoo-validation-runner.ts` (doc comment only)
- Modify: `.env.example` (comment only)

**Interfaces:** none (no new code; `OdooValidationRunner` already runs the project's modules against a scratch DB).

- [ ] **Step 1: Correct the stale doc comment**

In `odoo-validation-runner.ts`, the `ValidationRequest.repositoryPath` comment says "The task's clone. Never the live addons directory." Change it to:

```ts
  /** The task's clone, or the project's own addons directory in local execution mode. */
  readonly repositoryPath: string;
```

- [ ] **Step 2: Correct the `.env.example` comment**

The `ODOO_SHARED_ADDON_PATHS` comment says "The project's own addons come from the task's workspace, never the live directory." Amend to:

```bash
# Addon directories shared across every series: enterprise, OCA, and so on. The
# project's own addons come from the task's workspace — or, in local execution
# mode, from the project's own addons directory (localPath).
```

- [ ] **Step 3: Verify no new flag is needed**

There is no `LOCAL_EXECUTION_ENABLED` and no `run_odoo` tool. Validation turns on with `VALIDATION_ENABLED=true` + `ODOO_RUNTIMES` + `VALIDATION_DB_*` (already implemented and covered by `infrastructure/scripts/smoke-test-validation.sh` and `probe-validation-refusal.js`). Confirm `npm run typecheck` still passes.

- [ ] **Step 4: Commit**

```bash
git add backend/src/agent/validation/odoo-validation-runner.ts .env.example
git commit -m "docs: align validation comments with local execution mode"
```

---

### Task 9: Hermes preset in settings

**Files:**
- Modify: `frontend/app/settings/page.tsx`

**Interfaces:** none (the backend already accepts an `openai-compatible` provider at a loopback URL without a key — `isLoopbackUrl`).

- [ ] **Step 1: Add the quick-fill control**

In the "Base URL" block of `settings/page.tsx` (rendered when `selected.needsBaseUrl`), add a button after the reference table:

```tsx
              <button
                type="button"
                onClick={() => setBaseUrl('http://127.0.0.1:20128/v1')}
                disabled={!canEdit || saving}
                className="btn-ghost mt-2.5 px-2 py-1 text-2xs"
              >
                Use the local Hermes gateway (http://127.0.0.1:20128/v1)
              </button>
```

The model name is left for the person to type: Hermes serves whichever model is configured, and the platform must not invent one.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add frontend/app/settings/page.tsx
git commit -m "feat(settings): add Hermes local gateway quick-fill"
```

---

### Task 10: 3-type project wizard

**Files:**
- Modify: `frontend/lib/types.ts`
- Modify: `frontend/lib/api.ts`
- Modify: `frontend/app/projects/new/page.tsx`

**Interfaces:**
- Produces: `localPath` in the create payload; conditional fields for `on_premise` / `odoo_sh` / `odoo_online`.

- [ ] **Step 1: Add `localPath` to the API types**

In `frontend/lib/types.ts`, add to `ProjectDetail`:

```ts
  localPath: string | null;
```

In `frontend/lib/api.ts`, add to `projects.create`'s body type:

```ts
      localPath?: string;
```

- [ ] **Step 2: Add `localPath` to the form state**

In `ConnectExistingForm` (`frontend/app/projects/new/page.tsx`), add `localPath: ''` to the `form` state, and derive a `needsLocalPath` flag:

```ts
  const needsRepository = form.projectType === 'repository' || form.projectType === 'odoo_sh';
  const isOnPremise = form.projectType === 'on_premise';
```

- [ ] **Step 3: Render the on-premise field and drop the "not reachable" warning**

Replace the warning block (currently lines ~314-319) with:

```tsx
      {isOnPremise ? (
        <div className="sm:col-span-2">
          <label htmlFor="localPath" className="field-label">
            Addons directory
          </label>
          <input
            id="localPath"
            required
            value={form.localPath}
            onChange={update('localPath')}
            className="field-input font-mono text-xs"
            placeholder="/home/masbintang/linkederp/your_addons"
          />
          <p className="mt-1.5 text-2xs text-content-subtle">
            The directory is edited in place — no clone is made and nothing is deleted afterwards.
          </p>
        </div>
      ) : null}

      {form.projectType === 'odoo_online' ? (
        <Alert tone="warning" title="Coming soon">
          Odoo Online is a hosted SaaS with no local code, so the agent cannot reach it yet. This
          project type will be added in a later phase.
        </Alert>
      ) : null}
```

For `odoo_sh`, keep the existing repository/branch/environments fields and add an optional "Local clone directory" input (only when `form.projectType === 'odoo_sh'`):

```tsx
      {form.projectType === 'odoo_sh' ? (
        <div className="sm:col-span-2">
          <label htmlFor="localPath" className="field-label">
            Local clone directory (optional)
          </label>
          <input
            id="localPath"
            value={form.localPath}
            onChange={update('localPath')}
            className="field-input font-mono text-xs"
            placeholder="/home/masbintang/linkederp/your_project"
          />
          <p className="mt-1.5 text-2xs text-content-subtle">
            Cloned once into this directory; later tasks work on it directly. Leave blank to derive it
            from the project name.
          </p>
        </div>
      ) : null}
```

- [ ] **Step 4: Send `localPath` on submit**

In the `api.projects.create(...)` call inside `submit`, add `localPath: form.localPath.trim() || undefined`.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/lib/types.ts frontend/lib/api.ts frontend/app/projects/new/page.tsx
git commit -m "feat(frontend): 3-type project wizard with localPath"
```

---

### Task 11: Smoke test, ADR, README

**Files:**
- Create: `infrastructure/scripts/smoke-test-local-execution.sh`
- Create: `docs/adr/ADR-028-local-execution-mode.md`
- Modify: `README.md`

- [ ] **Step 1: Write the smoke test**

Mirror `smoke-test-repository.sh` (which creates a `file://` git fixture and drives a scripted change). This script asserts the new property — in-place edit, no clone, no deletion:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Local execution mode (on-premise in-place edit) smoke test.
# Assumes the API is running on http://localhost:4000/api/v1 and GIT_ALLOW_LOCAL_REMOTES=true.

BASE="${API_BASE:-http://localhost:4000/api/v1}"
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT

ADDONS="$ROOT/addons"
mkdir -p "$ADDONS/my_module"

git -C "$ROOT" init -q addons
git -C "$ADDONS" -c user.name=smoke -c user.email=smoke@test commit -q --allow-empty -m init

# 1. Create an on_premise project pointing at $ADDONS.
PROJECT_ID="$(curl -sf -X POST "$BASE/projects" -H 'content-type: application/json' \
  -d "{\"organizationId\":\"$ORG_ID\",\"name\":\"local-smoke\",\"projectType\":\"on_premise\",\"odooVersion\":\"18.0\",\"localPath\":\"$ADDONS\"}" \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')"

# 2. Submit a task, poll to completion, and assert the addons dir still exists and
#    was not replaced by a clone (its .git and files are intact).
# ... (poll POST "$BASE/projects/$PROJECT_ID/tasks" to completion, then:)
test -d "$ADDONS" || { echo "FAIL: addons directory was removed"; exit 1; }

echo "==> Local execution smoke test passed"
```

The executor should flesh out the auth/sign-in and polling steps to match `smoke-test-repository.sh`'s existing helpers (`jq`, an email/password bootstrap), reusing `create-test-repository.sh` conventions where useful.

- [ ] **Step 2: Write the ADR**

`docs/adr/ADR-028-local-execution-mode.md`, following the existing ADR format (`Status`, `Date`, `Context`, `Decision`, `Consequences`, `Verification`). It must record:
1. `localPath` as a first-class field with `resolveLocalPath` containment.
2. The persistent workspace strategy (metadata/logs in scratch root; `repositoryPath` is the project dir; `release` never deletes it).
3. Real `git_push` under `GIT_PUSH_ENABLED`, and that validation reuses ADR-027 (`VALIDATION_ENABLED`), not a new flag or tool.
4. `on_premise` is edited in place on the currently checked-out branch (no AI branch); commit/push/diff require the path to be a git working tree, and a non-git path fails the task with a clear error.
5. Hermes as a loopback `openai-compatible` provider preset.

- [ ] **Step 3: Update README**

Update the "What is deliberately not built" list and the "Two capabilities remain simulated" paragraph: push and validation are now real under `GIT_PUSH_ENABLED` / `VALIDATION_ENABLED` (with the process-layer guard still on by default), and add one line for local execution mode + `PROJECTS_ROOT`. Update the "Workspaces" row of the architecture table to note the persistent local strategy.

- [ ] **Step 4: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add infrastructure/scripts/smoke-test-local-execution.sh docs/adr/ADR-028-local-execution-mode.md README.md
git commit -m "docs: ADR-028 and smoke test for local execution mode"
```
