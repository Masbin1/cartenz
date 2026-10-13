# Odoo.sh Assisted Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "Create with AI" can start an Odoo.sh project: Cartenz records the Odoo.sh form values, the operator deploys at odoo.sh, and a "connect" button links the GitHub repository Odoo.sh created so tasks push to it.

**Architecture:** A third hosting target `odoo_sh` takes its own branch in `createAiProject` (mirrors the Odoo Online branch, touches nothing of it). The plan is stored in `environment_config.signup`. A new endpoint `POST /projects/:id/odoo-sh/connect` reads the repository through the GitHub API with a token registered in **Settings → Git credentials** (existing feature, ADR-058), makes sure a `development` branch exists, records a `github` connection through the existing `createConnection`, and sets `repository_url`.

**Tech Stack:** NestJS + class-validator + Drizzle (backend, Jest); Next.js 15 + React (frontend, `node:test` via `npm test`).

**Spec:** `docs/superpowers/specs/2026-10-14-odoo-sh-assisted-creation-design.md`

**Amendments to the spec (agreed 14 October 2026):**
1. The token for the connect step comes from a registered Git credential (Settings → Git credentials, kind `token`, host `github.com`). `GITHUB_TOKEN` from `.env` is only a fallback. No new settings screen: the existing one already stores access tokens.
2. The owner is a form field (`owner` + `repositoryName`), not `GITHUB_OWNER`.
3. The Odoo version reuses the existing `odooVersion` field and its existing allowed values (`19.0`, `20.0`).
4. Environments at creation: Development only (branch `development`, default target). The production branch is learned at connect time (the repository's default branch) and written to `projects.default_branch`.

## Global Constraints

- Do not change the Odoo Online flow: `createOdooOnlineAiProject`, `OdooOnlineSignupDto`, `OdooOnlineSetupPanel`, `frontend/lib/odoo-online-apps.ts`. The only Odoo Online file edited is `odoo-online-hosting.dto.spec.ts`, and only the value in its "not offered" test.
- No database migration. The plan lives in `environment_config` JSON.
- The Odoo.sh subscription code is never collected, stored or logged.
- No token in a URL, a log line, an error message, or a response body.
- Region values are exactly the Odoo.sh map values: `am` Americas, `ca` Canada, `eu` Europe, `sa` Middle East, `me` Southern Asia, `as` Southeast Asia, `au` Oceania.
- Odoo.sh project creation URL: `https://www.odoo.sh/project/create`.
- The working tree has unrelated staged files (`.commandcode/…`). **Commit only named paths** with `git commit -m "…" -- <paths>`; never `git add -A` or a bare `git commit`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. The operator clicks "connect" before finishing the deploy at odoo.sh: expect a 400 that says to finish the deploy first, and no connection row (Task 2 test for 404 → null; Task 3 manual check).
2. The registered token cannot see the repository (fine-grained token limited to selected repositories): same message plus a hint about token scope, not a 500 (Task 2 test: 404 → null; Task 3 message text).
3. "Connect" clicked twice: the second call must not create a second `github` connection (Task 3: early return when a repository URL is already set).
4. The repository Odoo.sh created has no commits yet: expect a clear 400 rather than a crash while creating the `development` branch (Task 2 test).
5. Bad input at the trust boundary: an owner or repository name with a slash, a space or a leading hyphen; an unknown region (Task 1 tests).

---

### Task 1: Hosting target and DTO

**Files:**
- Modify: `backend/src/core/enums.ts:30-40`
- Modify: `backend/src/modules/projects/dto/project.dto.ts` (add `OdooShSignupDto` after `OdooOnlineSignupDto`, add `odooSh` to `CreateAiProjectDto`, add `ConnectOdooShDto`)
- Modify: `backend/src/modules/projects/odoo-online-hosting.dto.spec.ts:52-55`
- Create: `backend/src/modules/projects/odoo-sh-hosting.dto.spec.ts`

**Interfaces:**
- Produces: `ODOO_SH_REGIONS`, `type OdooShRegion`, `AI_HOSTING_TARGETS` including `'odoo_sh'`; `OdooShSignupDto { owner: string; repositoryName: string; region: OdooShRegion }`; `CreateAiProjectDto.odooSh?: OdooShSignupDto`; `ConnectOdooShDto { credentialId?: string }`.

- [ ] **Step 1: Write the failing test**

Create `backend/src/modules/projects/odoo-sh-hosting.dto.spec.ts`:

```ts
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateAiProjectDto } from './dto/project.dto';

/** The Odoo.sh hosting additions to the Create-with-AI payload (ADR-071). */
const base = {
  region: 'indonesia',
  name: 'Equipment Management',
  odooVersion: '19.0',
  description: 'Manage company assets.',
  requirements: [{ title: 'Register equipment against an employee' }],
};

const build = (odooSh: Record<string, unknown> | undefined) =>
  plainToInstance(CreateAiProjectDto, { ...base, hosting: 'odoo_sh', odooSh });

const odooShInvalid = async (odooSh: Record<string, unknown>) =>
  (await validate(build(odooSh))).some((error) => error.property === 'odooSh');

describe('CreateAiProjectDto odoo_sh hosting', () => {
  const valid = { owner: 'BintangLinked', repositoryName: 'equipment-management', region: 'as' };

  it('accepts an odoo_sh project with a complete plan', async () => {
    expect(await validate(build(valid))).toHaveLength(0);
  });

  it.each([
    ['owner with a slash', { ...valid, owner: 'Bintang/Linked' }],
    ['owner with a leading hyphen', { ...valid, owner: '-bintang' }],
    ['repository name with a space', { ...valid, repositoryName: 'equipment management' }],
    ['repository name with a leading dot', { ...valid, repositoryName: '.equipment' }],
    ['unknown region', { ...valid, region: 'id' }],
  ])('refuses an %s', async (_label, odooSh) => {
    expect(await odooShInvalid(odooSh)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest src/modules/projects/odoo-sh-hosting.dto.spec.ts`
Expected: FAIL. The valid case reports a `hosting` error, because `odoo_sh` is not yet in `AI_HOSTING_TARGETS`.

- [ ] **Step 3: Implement**

In `backend/src/core/enums.ts`, replace the last sentence of the comment above `AI_HOSTING_TARGETS` and the constant:

```ts
 * reCAPTCHA v3 and Cloudflare Turnstile, so it cannot be automated and is
 * assisted instead. `odoo_sh` is assisted the same way (ADR-071): Odoo.sh has
 * no project-creation API and its login is GitHub OAuth.
 */
export const AI_HOSTING_TARGETS = ['on_host', 'odoo_online', 'odoo_sh'] as const;
export type AiHostingTarget = (typeof AI_HOSTING_TARGETS)[number];

/**
 * Odoo.sh hosting locations, as the values its project form posts (ADR-071).
 * `sa` is Middle East and `me` Southern Asia: Odoo's spelling, kept verbatim.
 */
export const ODOO_SH_REGIONS = ['am', 'ca', 'eu', 'sa', 'me', 'as', 'au'] as const;
export type OdooShRegion = (typeof ODOO_SH_REGIONS)[number];
```

In `backend/src/modules/projects/dto/project.dto.ts`, add `ODOO_SH_REGIONS` and `type OdooShRegion` to the existing `../../../core/enums` import. Then add after `OdooOnlineSignupDto`:

```ts
/**
 * What the Odoo.sh "Deploy your platform" form needs, minus the subscription
 * code (ADR-071). The code is a secret Cartenz cannot use, because only the
 * operator's own Odoo.sh session can submit that form, so it is not collected.
 */
export class OdooShSignupDto {
  /** GitHub account or organisation, as GitHub spells user names. */
  @IsString()
  @Matches(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, {
    message: 'owner must be a GitHub user or organisation name',
  })
  @Transform(trim)
  owner!: string;

  /** Same rule as `GitHubClient`'s REPOSITORY_NAME. */
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/, {
    message: 'repositoryName must be a GitHub repository name',
  })
  @Transform(trim)
  repositoryName!: string;

  @IsIn(ODOO_SH_REGIONS, { message: `region must be one of: ${ODOO_SH_REGIONS.join(', ')}` })
  region!: OdooShRegion;
}
```

In `CreateAiProjectDto`, after the `odooOnline` property:

```ts
  /**
   * The Odoo.sh deploy plan. Required when `hosting` is `odoo_sh` (checked in
   * the service); ignored otherwise.
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => OdooShSignupDto)
  odooSh?: OdooShSignupDto;
```

At the end of the file:

```ts
/** Body of POST /projects/:id/odoo-sh/connect. */
export class ConnectOdooShDto {
  /** A registered Git credential (Settings → Git credentials); omitted means the default. */
  @IsOptional()
  @IsUUID()
  credentialId?: string;
}
```

In `backend/src/modules/projects/odoo-online-hosting.dto.spec.ts`, replace the "refuses a hosting target that is not offered" test body:

```ts
  it('refuses a hosting target that is not offered', async () => {
    expect(hasError(await validate(build({ hosting: 'odoo_cloud' })), 'hosting')).toBe(true);
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npx jest src/modules/projects/odoo-sh-hosting.dto.spec.ts src/modules/projects/odoo-online-hosting.dto.spec.ts`
Expected: PASS for both files.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(projects): accept odoo_sh as a Create-with-AI hosting target

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- backend/src/core/enums.ts backend/src/modules/projects/dto/project.dto.ts backend/src/modules/projects/odoo-sh-hosting.dto.spec.ts backend/src/modules/projects/odoo-online-hosting.dto.spec.ts
```

Run `git add backend/src/modules/projects/odoo-sh-hosting.dto.spec.ts` first, because a new file must be tracked before `git commit -- <path>` will take it.

---

### Task 2: GitHub client: read a repository and ensure a branch

**Files:**
- Modify: `backend/src/agent/git/github-client.ts`
  - widen `request`'s `method` type to `'GET' | 'POST'` (it already is; no change)
  - add two public methods after `ensureRepository`
- Test: `backend/src/agent/git/github-client.spec.ts` (append a `describe`)

**Interfaces:**
- Produces:
  - `GitHubClient.getRepository(owner: string, name: string, token: string): Promise<GitHubRepository | null>`, where `null` means GitHub answered 404. That covers both a missing repository and one the token cannot see.
  - `GitHubClient.ensureBranch(owner: string, name: string, branch: string, fromBranch: string, token: string): Promise<boolean>`, which returns `true` when it created the branch. It throws `GitHubApiError` when `fromBranch` has no commits.

- [ ] **Step 1: Write the failing tests**

Append to `backend/src/agent/git/github-client.spec.ts`, inside the outer `describe('GitHubClient', …)`, before its closing `});`:

```ts
  describe('with an explicit token (Odoo.sh connect, ADR-071)', () => {
    const client = () => new GitHubClient(config({ token: null, owner: null }));

    it('reads a repository with the token it is given', async () => {
      fetchMock.mockResolvedValueOnce(json(repositoryPayload('BintangLinked/equip')));

      const repository = await client().getRepository('BintangLinked', 'equip', 'ghp_registered');

      expect(repository?.cloneUrl).toBe('https://github.com/BintangLinked/equip.git');
      expect(calls()[0].url).toBe('https://api.github.com/repos/BintangLinked/equip');
      expect(calls()[0].url).not.toContain('ghp_registered');
    });

    it('answers null when GitHub says 404', async () => {
      fetchMock.mockResolvedValueOnce(json({ message: 'Not Found' }, 404));
      expect(await client().getRepository('BintangLinked', 'missing', 'ghp_registered')).toBeNull();
    });

    it('leaves an existing branch alone', async () => {
      fetchMock.mockResolvedValueOnce(json({ object: { sha: 'abc' } }));
      expect(
        await client().ensureBranch('BintangLinked', 'equip', 'development', 'main', 'ghp_registered'),
      ).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('creates a missing branch from the head of the base branch', async () => {
      fetchMock
        .mockResolvedValueOnce(json({ message: 'Not Found' }, 404))
        .mockResolvedValueOnce(json({ object: { sha: 'abc123' } }))
        .mockResolvedValueOnce(json({ ref: 'refs/heads/development' }, 201));

      expect(
        await client().ensureBranch('BintangLinked', 'equip', 'development', 'main', 'ghp_registered'),
      ).toBe(true);
      expect(calls()[2].url).toBe('https://api.github.com/repos/BintangLinked/equip/git/refs');
      expect(calls()[2].body).toEqual({ ref: 'refs/heads/development', sha: 'abc123' });
    });

    it('explains an empty repository instead of failing on a missing sha', async () => {
      fetchMock
        .mockResolvedValueOnce(json({ message: 'Not Found' }, 404))
        .mockResolvedValueOnce(json({ message: 'Git Repository is empty.' }, 409));

      await expect(
        client().ensureBranch('BintangLinked', 'equip', 'development', 'main', 'ghp_registered'),
      ).rejects.toThrow(/Git Repository is empty/);
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx jest src/agent/git/github-client.spec.ts`
Expected: FAIL with "getRepository is not a function".

- [ ] **Step 3: Implement**

In `backend/src/agent/git/github-client.ts`, add after `ensureRepository` and before `accountType`:

```ts
  /**
   * A repository someone else created, read with a token the caller supplies
   * (ADR-071: Odoo.sh creates the repository; Cartenz only adopts it).
   *
   * Null on 404. GitHub returns 404 both for a repository that does not exist
   * and for one the token cannot see, and the caller's message covers both.
   */
  async getRepository(owner: string, name: string, token: string): Promise<GitHubRepository | null> {
    const payload = await this.request<GitHubRepositoryPayload>(
      token,
      'GET',
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
      { notFoundIsNull: true },
    );
    return payload ? this.toRepository(payload, false) : null;
  }

  /**
   * Makes `branch` exist on the remote, created at the head of `fromBranch`.
   *
   * A task's per-task clone checks out its environment's branch, and a
   * repository Odoo.sh has just created has only its production branch. Pushing
   * `development` here also gives Odoo.sh a development build to show.
   */
  async ensureBranch(
    owner: string,
    name: string,
    branch: string,
    fromBranch: string,
    token: string,
  ): Promise<boolean> {
    const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git`;
    const existing = await this.request<{ object?: { sha?: string } }>(
      token,
      'GET',
      `${base}/ref/heads/${encodeURIComponent(branch)}`,
      { notFoundIsNull: true },
    );
    if (existing) return false;

    // Throws with GitHub's own words ("Git Repository is empty.") when there is
    // nothing to branch from, which is the message the operator can act on.
    const head = await this.request<{ object?: { sha?: string } }>(
      token,
      'GET',
      `${base}/ref/heads/${encodeURIComponent(fromBranch)}`,
    );
    if (!head.object?.sha) {
      throw new GitHubApiError(0, `the branch "${fromBranch}" has no commit`, 'Creating a branch');
    }

    await this.request(token, 'POST', `${base}/refs`, {
      body: { ref: `refs/heads/${branch}`, sha: head.object.sha },
    });
    return true;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npx jest src/agent/git/github-client.spec.ts`
Expected: PASS, with the existing tests unchanged.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(github): read an adopted repository and ensure a branch with a supplied token

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- backend/src/agent/git/github-client.ts backend/src/agent/git/github-client.spec.ts
```

---

### Task 3: Create the plan, then connect the repository

**Files:**
- Create: `backend/src/modules/projects/odoo-sh-signup.ts` (pure reader of the stored plan)
- Create: `backend/src/modules/projects/odoo-sh-signup.spec.ts`
- Modify: `backend/src/modules/projects/projects.service.ts`. Add a branch at around line 1147, after the Odoo Online `if`. Add the private `createOdooShAiProject` after `createOdooOnlineAiProject`. Add a public `connectOdooSh` after `createConnection`. Add `GitHubClient` to the constructor.
- Modify: `backend/src/modules/projects/projects.controller.ts` (route after `createConnection`, around line 250)
- Modify: `backend/src/core/audit/audit-events.ts` (after `PROJECT_GITHUB_REPOSITORY_FAILED`)

**Interfaces:**
- Consumes: Task 1's `OdooShSignupDto` and `ConnectOdooShDto`; Task 2's `getRepository` and `ensureBranch`; the existing `GitCredentialsService.resolveForHost({ credentialId, host })` and `ProjectsService.createConnection(user, projectId, dto)`.
- Produces:
  - `odooShSignupOf(environmentConfig: unknown): OdooShSignup | null`;
  - `POST /projects/:projectId/odoo-sh/connect` → `{ repository: string; url: string; defaultBranch: string; createdBranch: boolean }`;
  - the audit event `PROJECT_ODOO_SH_CONNECTED: 'project.odoo_sh_connected'`.

- [ ] **Step 1: Write the failing test for the plan reader**

Create `backend/src/modules/projects/odoo-sh-signup.spec.ts`:

```ts
import { odooShSignupOf } from './odoo-sh-signup';

describe('odooShSignupOf', () => {
  const signup = { owner: 'BintangLinked', repositoryName: 'equip', region: 'as', odooVersion: '19.0' };

  it('reads the plan an odoo_sh creation stored', () => {
    expect(odooShSignupOf({ hosting: 'odoo_sh', signup })).toEqual(signup);
  });

  it.each([
    ['no config', null],
    ['an Odoo Online plan', { hosting: 'odoo_online', signup }],
    ['a plan without a repository', { hosting: 'odoo_sh', signup: { ...signup, repositoryName: '' } }],
  ])('is null for %s', (_label, config) => {
    expect(odooShSignupOf(config)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && npx jest src/modules/projects/odoo-sh-signup.spec.ts`
Expected: FAIL with "Cannot find module './odoo-sh-signup'".

- [ ] **Step 3: Implement the reader**

Create `backend/src/modules/projects/odoo-sh-signup.ts`:

```ts
/**
 * The Odoo.sh deploy plan recorded at creation (ADR-071), read back from
 * `environment_config`. Null for anything that is not an assisted Odoo.sh
 * project, including one connected the older way, which has no plan.
 */
export interface OdooShSignup {
  readonly owner: string;
  readonly repositoryName: string;
  readonly region: string;
  readonly odooVersion: string;
}

export function odooShSignupOf(environmentConfig: unknown): OdooShSignup | null {
  if (!environmentConfig || typeof environmentConfig !== 'object') return null;
  const config = environmentConfig as Record<string, unknown>;
  if (config.hosting !== 'odoo_sh' || !config.signup || typeof config.signup !== 'object') return null;

  const signup = config.signup as Record<string, unknown>;
  const text = (key: string) => (typeof signup[key] === 'string' ? (signup[key] as string) : '');
  if (!text('owner') || !text('repositoryName')) return null;

  return {
    owner: text('owner'),
    repositoryName: text('repositoryName'),
    region: text('region'),
    odooVersion: text('odooVersion'),
  };
}
```

Run: `cd backend && npx jest src/modules/projects/odoo-sh-signup.spec.ts`
Expected: PASS.

- [ ] **Step 4: Add the audit event**

In `backend/src/core/audit/audit-events.ts`, after `PROJECT_GITHUB_REPOSITORY_FAILED`:

```ts
  /** An assisted Odoo.sh project was connected to the repository Odoo.sh created (ADR-071). */
  PROJECT_ODOO_SH_CONNECTED: 'project.odoo_sh_connected',
```

- [ ] **Step 5: Add the creation branch**

In `backend/src/modules/projects/projects.service.ts`, directly after the existing `if ((dto.hosting ?? 'on_host') === 'odoo_online') { … }` block (around line 1147-1149):

```ts
    // Odoo.sh is deployed by the operator at odoo.sh, which also creates the
    // GitHub repository (ADR-071). Like Odoo Online: record the plan, provision nothing.
    if (dto.hosting === 'odoo_sh') {
      return this.createOdooShAiProject(user, dto);
    }
```

Add this private method directly after `createOdooOnlineAiProject`:

```ts
  /**
   * Records an Odoo.sh project and its deploy plan (ADR-071).
   *
   * No directory, no scaffold and no GitHub call. If Cartenz created the
   * repository first, Odoo.sh's "New repository" deploy would fail on the name.
   * `repository_url` stays null until `connectOdooSh`, which is what the task
   * guard reads, so no task can run against a repository that does not exist yet.
   */
  private async createOdooShAiProject(user: AuthenticatedUser, dto: CreateAiProjectDto) {
    const plan = dto.odooSh;
    if (!plan) {
      throw new BadRequestException(
        'An Odoo.sh project needs its deploy plan: GitHub owner, repository name and region.',
      );
    }

    const specification = buildProjectSpecification({
      projectName: dto.name,
      odooVersion: dto.odooVersion,
      description: dto.description,
      requirements: dto.requirements,
      modules: undefined,
    });

    const result = await this.database.transaction(async (tx) => {
      const [project] = await tx
        .insert(projects)
        .values({
          region: dto.region,
          name: dto.name,
          description: dto.description,
          projectType: 'odoo_sh',
          odooVersion: dto.odooVersion,
          // Odoo.sh runs Enterprise only.
          odooEdition: 'enterprise',
          // Replaced at connect time by the repository's own default branch.
          defaultBranch: 'main',
          repositoryUrl: null,
          environmentConfig: {
            hosting: 'odoo_sh',
            signup: {
              owner: plan.owner,
              repositoryName: plan.repositoryName,
              region: plan.region,
              odooVersion: dto.odooVersion,
            },
          },
          agentPermissions: { ...DEFAULT_AGENT_PERMISSIONS },
          createdByUserId: user.userId,
          provisioningStatus: 'none',
        })
        .returning();

      // Development is where tasks land; Odoo.sh builds the branch on each push.
      // Production is not declared: it is never a task target (ADR-021).
      await tx.insert(projectEnvironments).values(
        this.environments.buildForCreation(project.id, 'main', [
          { name: 'Development', branch: 'development', kind: 'development', isDefaultTarget: true },
        ]),
      );

      const [spec] = await tx
        .insert(projectSpecifications)
        .values({
          projectId: project.id,
          version: 1,
          specification: specification as unknown as Record<string, unknown>,
          createdByUserId: user.userId,
        })
        .returning();

      return { project, spec };
    });

    await this.audit.record({
      event: AUDIT_EVENTS.PROJECT_CREATED,
      projectId: result.project.id,
      userId: user.userId,
      metadata: {
        name: result.project.name,
        projectType: 'odoo_sh',
        flow: 'create_with_ai',
        hosting: 'odoo_sh',
        requirementCount: specification.requirements.length,
      },
    });

    await this.audit.record({
      event: AUDIT_EVENTS.PROJECT_SPECIFICATION_CREATED,
      projectId: result.project.id,
      userId: user.userId,
      metadata: { version: 1 },
    });

    return {
      ...this.present(result.project),
      specification: result.spec.specification,
      github: null,
    };
  }
```

- [ ] **Step 6: Add the connect method**

Add `private readonly github: GitHubClient,` as the last constructor parameter, and add the imports:

```ts
import { GitHubClient, GitHubApiError } from '../../agent/git/github-client';
import { odooShSignupOf } from './odoo-sh-signup';
```

`GitHubClient` is already exported by `AgentModule`, which `ProjectsModule` imports, so no module change is needed. Add `ConnectOdooShDto` to the existing `./dto/project.dto` import.

Add this method directly after `createConnection`:

```ts
  /**
   * Connects an assisted Odoo.sh project to the repository Odoo.sh created (ADR-071).
   *
   * The token comes from Settings → Git credentials (ADR-058). `GITHUB_TOKEN` is
   * a fallback so a deployment configured the older way keeps working.
   * Idempotent: once `repository_url` is set, a second click reports the same
   * repository rather than recording a second connection.
   */
  async connectOdooSh(user: AuthenticatedUser, projectId: string, dto: ConnectOdooShDto) {
    await this.authz.requireProjectAccess(user, projectId, { requireAdmin: true });

    const [project] = await this.database.db
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!project) throw new NotFoundException('Project not found');

    const plan = project.projectType === 'odoo_sh' ? odooShSignupOf(project.environmentConfig) : null;
    if (!plan) {
      throw new BadRequestException('This project was not created as an Odoo.sh project.');
    }

    const fullName = `${plan.owner}/${plan.repositoryName}`;
    if (project.repositoryUrl) {
      return {
        repository: fullName,
        url: `https://github.com/${fullName}`,
        defaultBranch: project.defaultBranch,
        createdBranch: false,
      };
    }

    const registered = await this.gitCredentials.resolveForHost({
      credentialId: dto.credentialId ?? null,
      host: 'github.com',
    });
    const token =
      registered?.kind === 'token' ? registered.value : (this.config.github.token ?? null);
    if (!token) {
      throw new BadRequestException(
        'No GitHub access token is available. Add one in Settings → Git credentials ' +
          '(kind: Access token, host: github.com).',
      );
    }

    let repository;
    let createdBranch: boolean;
    try {
      repository = await this.github.getRepository(plan.owner, plan.repositoryName, token);
      if (!repository) {
        throw new BadRequestException(
          `The repository ${fullName} was not found. Finish the deploy on Odoo.sh first. ` +
            'If it is deployed, the access token cannot see it: give the token access to ' +
            `all repositories of ${plan.owner}.`,
        );
      }
      createdBranch = await this.github.ensureBranch(
        plan.owner,
        plan.repositoryName,
        'development',
        repository.defaultBranch,
        token,
      );
    } catch (error) {
      if (error instanceof GitHubApiError) throw new BadRequestException(error.message);
      throw error;
    }

    // The existing path: adopts the registered credential's secret by reference,
    // or seals the fallback token against this project.
    await this.createConnection(user, projectId, {
      connectionType: 'github',
      credentialKind: 'token',
      ...(registered?.kind === 'token'
        ? { credentialId: registered.credentialId ?? undefined }
        : { credential: token }),
      metadata: {
        repository: repository.fullName,
        url: repository.htmlUrl,
        repositoryUrl: repository.cloneUrl,
        cloneUrl: repository.cloneUrl,
        branch: repository.defaultBranch,
      },
    } as CreateConnectionDto);

    await this.database.db
      .update(projects)
      .set({
        repositoryUrl: repository.cloneUrl,
        defaultBranch: repository.defaultBranch,
        updatedAt: new Date(),
      })
      .where(eq(projects.id, projectId));

    await this.audit.record({
      event: AUDIT_EVENTS.PROJECT_ODOO_SH_CONNECTED,
      projectId,
      userId: user.userId,
      metadata: {
        repository: repository.fullName,
        defaultBranch: repository.defaultBranch,
        createdBranch,
        registeredCredentialId: registered?.credentialId ?? null,
      },
    });

    return {
      repository: repository.fullName,
      url: repository.htmlUrl,
      defaultBranch: repository.defaultBranch,
      createdBranch,
    };
  }
```

- [ ] **Step 7: Add the route**

In `backend/src/modules/projects/projects.controller.ts`, after `createConnection`, and add `ConnectOdooShDto` to the DTO import:

```ts
  /** Links an assisted Odoo.sh project to the repository Odoo.sh created (ADR-071). */
  @Post(':projectId/odoo-sh/connect')
  connectOdooSh(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: ConnectOdooShDto,
  ) {
    return this.projects.connectOdooSh(user, projectId, dto);
  }
```

- [ ] **Step 8: Typecheck and run the module's tests**

Run: `cd backend && npx tsc --noEmit -p tsconfig.json && npx jest src/modules/projects src/agent/git`
Expected: no type errors, all tests PASS.

- [ ] **Step 9: Commit**

```bash
git add backend/src/modules/projects/odoo-sh-signup.ts backend/src/modules/projects/odoo-sh-signup.spec.ts
git commit -m "feat(projects): create an assisted Odoo.sh project and connect its repository

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- backend/src/modules/projects/odoo-sh-signup.ts backend/src/modules/projects/odoo-sh-signup.spec.ts backend/src/modules/projects/projects.service.ts backend/src/modules/projects/projects.controller.ts backend/src/core/audit/audit-events.ts
```

---

### Task 4: Frontend helpers and API

**Files:**
- Create: `frontend/lib/odoo-sh.ts`
- Create: `frontend/lib/odoo-sh.test.ts`
- Modify: `frontend/lib/api.ts`
  - widen the `hosting` union (around line 542) and add the `odooSh` block;
  - add `connectOdooSh` after `createConnection` (around line 790).

**Interfaces:**
- Produces:
  - `ODOO_SH_CREATE_URL`;
  - `ODOO_SH_REGIONS: readonly { value: string; label: string }[]`;
  - `odooShRegionLabel(value)`;
  - `ODOO_SH_OWNER`, `ODOO_SH_REPOSITORY` (RegExp);
  - `odooShSignupOf(project: { projectType: string; environmentConfig: Record<string, unknown> }): OdooShSignup | null`;
  - `api.projects.connectOdooSh(projectId, { credentialId? })`.

- [ ] **Step 1: Write the failing test**

Create `frontend/lib/odoo-sh.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { ODOO_SH_OWNER, ODOO_SH_REPOSITORY, odooShRegionLabel, odooShSignupOf } from './odoo-sh';

test('region labels follow the Odoo.sh map, including its sa/me spelling', () => {
  assert.equal(odooShRegionLabel('as'), 'Southeast Asia');
  assert.equal(odooShRegionLabel('sa'), 'Middle East');
  assert.equal(odooShRegionLabel('me'), 'Southern Asia');
});

test('owner and repository rules match the backend DTO', () => {
  assert.ok(ODOO_SH_OWNER.test('BintangLinked'));
  assert.ok(!ODOO_SH_OWNER.test('Bintang/Linked'));
  assert.ok(ODOO_SH_REPOSITORY.test('equipment-management'));
  assert.ok(!ODOO_SH_REPOSITORY.test('equipment management'));
});

test('reads the stored plan only from an assisted odoo_sh project', () => {
  const signup = { owner: 'BintangLinked', repositoryName: 'equip', region: 'as', odooVersion: '19.0' };
  assert.deepEqual(
    odooShSignupOf({ projectType: 'odoo_sh', environmentConfig: { hosting: 'odoo_sh', signup } }),
    signup,
  );
  assert.equal(odooShSignupOf({ projectType: 'odoo_sh', environmentConfig: {} }), null);
  assert.equal(
    odooShSignupOf({ projectType: 'odoo_online', environmentConfig: { hosting: 'odoo_sh', signup } }),
    null,
  );
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npm test -- lib/odoo-sh`
Expected: FAIL. The build cannot resolve `./odoo-sh`.

- [ ] **Step 3: Implement**

Create `frontend/lib/odoo-sh.ts`:

```ts
/**
 * Odoo.sh assisted creation (ADR-071): the values of Odoo.sh's own
 * "Deploy your platform" form, so the operator copies rather than retypes them.
 */
export const ODOO_SH_CREATE_URL = 'https://www.odoo.sh/project/create';

/** Odoo.sh's region values, verbatim; `sa` is Middle East and `me` Southern Asia. */
export const ODOO_SH_REGIONS: readonly { value: string; label: string }[] = [
  { value: 'am', label: 'Americas' },
  { value: 'ca', label: 'Canada' },
  { value: 'eu', label: 'Europe' },
  { value: 'sa', label: 'Middle East' },
  { value: 'me', label: 'Southern Asia' },
  { value: 'as', label: 'Southeast Asia' },
  { value: 'au', label: 'Oceania' },
];

export const odooShRegionLabel = (value: string): string =>
  ODOO_SH_REGIONS.find((region) => region.value === value)?.label ?? value;

/** Same rules as the backend's OdooShSignupDto. */
export const ODOO_SH_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
export const ODOO_SH_REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export interface OdooShSignup {
  owner: string;
  repositoryName: string;
  region: string;
  odooVersion: string;
}

export function odooShSignupOf(project: {
  projectType: string;
  environmentConfig: Record<string, unknown> | null;
}): OdooShSignup | null {
  const config = project.environmentConfig;
  if (project.projectType !== 'odoo_sh' || !config || config.hosting !== 'odoo_sh') return null;
  const signup = config.signup;
  if (!signup || typeof signup !== 'object') return null;

  const value = signup as Record<string, unknown>;
  const text = (key: string) => (typeof value[key] === 'string' ? (value[key] as string) : '');
  if (!text('owner') || !text('repositoryName')) return null;

  return {
    owner: text('owner'),
    repositoryName: text('repositoryName'),
    region: text('region'),
    odooVersion: text('odooVersion'),
  };
}
```

In `frontend/lib/api.ts`, change `hosting?: 'on_host' | 'odoo_online';` to `hosting?: 'on_host' | 'odoo_online' | 'odoo_sh';`, and add after the `odooOnline?: { … };` block:

```ts
      /** The Odoo.sh deploy plan (ADR-071); required when `hosting` is `odoo_sh`. */
      odooSh?: { owner: string; repositoryName: string; region: string };
```

After the `createConnection` entry, using the same `request` helper and style:

```ts
    /** Links an assisted Odoo.sh project to the repository Odoo.sh created (ADR-071). */
    connectOdooSh: (projectId: string, body: { credentialId?: string }) =>
      request<{ repository: string; url: string; defaultBranch: string; createdBranch: boolean }>(
        `/projects/${projectId}/odoo-sh/connect`,
        { method: 'POST', body },
      ),
```

- [ ] **Step 4: Run the test and the typecheck**

Run: `cd frontend && npm test -- lib/odoo-sh && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/lib/odoo-sh.ts frontend/lib/odoo-sh.test.ts
git commit -m "feat(portal): Odoo.sh plan helpers and connect API

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- frontend/lib/odoo-sh.ts frontend/lib/odoo-sh.test.ts frontend/lib/api.ts
```

---

### Task 5: Create-with-AI form: the Odoo.sh tile and fields

**Files:**
- Modify: `frontend/app/projects/new/page.tsx` (`CreateWithAiForm`, starting at line 1167)

**Interfaces:**
- Consumes: Task 4's `ODOO_SH_REGIONS`, `ODOO_SH_OWNER`, `ODOO_SH_REPOSITORY`, and the `odooSh` payload type.

- [ ] **Step 1: State and readiness**

Change the hosting state (line 1189) to:

```tsx
  const [hosting, setHosting] = useState<'on_host' | 'odoo_online' | 'odoo_sh'>('on_host');
  const [odooSh, setOdooSh] = useState({ owner: '', repositoryName: '', region: 'as' });
```

Replace the `odooOnlineReady` expression (line 1228) so each hosting checks its own fields. Keep the Odoo Online condition exactly as it is:

```tsx
  const odooOnlineReady =
    hosting === 'on_host' ||
    (hosting === 'odoo_sh'
      ? ODOO_SH_OWNER.test(odooSh.owner.trim()) && ODOO_SH_REPOSITORY.test(odooSh.repositoryName.trim())
      : odooOnline.companyName.trim().length > 0 &&
        /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(odooOnline.adminEmail.trim()) &&
        ODOO_ONLINE_SUBDOMAIN.test(odooOnline.subdomain.trim()));
```

Import `ODOO_SH_OWNER`, `ODOO_SH_REPOSITORY` and `ODOO_SH_REGIONS` from `@/lib/odoo-sh`.

- [ ] **Step 2: Payload**

In the submit payload (lines 1273-1290), set `odooEdition: hosting === 'on_host' ? odooEdition : 'enterprise',` and replace the `...(hosting === 'on_host' ? {…} : {…odoo_online…})` spread with:

```tsx
        ...(hosting === 'on_host'
          ? { modules: installMode === 'choose' ? selectedModules : undefined }
          : hosting === 'odoo_sh'
            ? {
                hosting: 'odoo_sh' as const,
                odooSh: {
                  owner: odooSh.owner.trim(),
                  repositoryName: odooSh.repositoryName.trim(),
                  region: odooSh.region,
                },
              }
            : {
                hosting: 'odoo_online' as const,
                odooOnline: {
                  /* the existing object, unchanged */
                },
              }),
```

The `/* the existing object, unchanged */` comment means: keep the current `odooOnline: {…}` literal exactly as it is today. Do not copy the comment into the code.

- [ ] **Step 3: Enable the tile**

Replace the disabled Odoo.sh `ChoiceTile` (lines ~1400-1409) with:

```tsx
            <ChoiceTile
              name="hosting"
              value="odoo_sh"
              checked={hosting === 'odoo_sh'}
              onChange={() => setHosting('odoo_sh')}
              icon={Cloud}
              title="Odoo.sh"
              description="Deployed at odoo.sh from the details you fill here. Cartenz connects the GitHub repository Odoo.sh creates."
            />
```

Change the section's grid from `sm:grid-cols-2` to `sm:grid-cols-3`. Change its description to: "On this server, Cartenz provisions and runs the instance. On Odoo Online or Odoo.sh, the instance is created there and Cartenz connects it once it exists."

- [ ] **Step 4: Odoo.sh fields**

The Odoo Online signup section currently renders on the else branch of `{hosting === 'on_host' ? (<Section title="Modules">…) : (<Section title="Odoo Online signup">…)}` (line ~1496). Change only that `) : (` to `) : hosting === 'odoo_online' ? (` and its closing `)}` to `) : null}`. Fix the submit error (line ~1259) so it names the right form:

```tsx
    if (!odooOnlineReady) {
      setError(
        hosting === 'odoo_sh'
          ? 'Fill the Odoo.sh deploy: a GitHub owner and a repository name (letters, digits, ".", "_" or "-").'
          : 'Fill the Odoo Online signup: company name, a valid admin email and a subdomain of 4-50 lowercase letters, digits or hyphens.',
      );
      return;
    }
```

Then add, directly after the "Where it runs" `</Section>`:

```tsx
      {hosting === 'odoo_sh' ? (
        <Section
          size="small"
          divided
          title="Odoo.sh deploy"
          description="The same values the odoo.sh form asks for. The subscription code is entered at odoo.sh only; Cartenz never sees it."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="sh-owner" className="field-label">GitHub owner</label>
              <input
                id="sh-owner"
                className="field-input"
                value={odooSh.owner}
                onChange={(event) => setOdooSh((p) => ({ ...p, owner: event.target.value }))}
                placeholder="BintangLinked"
                autoComplete="off"
              />
            </div>
            <div>
              <label htmlFor="sh-repository" className="field-label">Repository name</label>
              <input
                id="sh-repository"
                className="field-input"
                value={odooSh.repositoryName}
                onChange={(event) => setOdooSh((p) => ({ ...p, repositoryName: event.target.value }))}
                placeholder="equipment-management"
                autoComplete="off"
              />
            </div>
            <div>
              <label htmlFor="sh-region" className="field-label">Hosting location</label>
              <select
                id="sh-region"
                className="field-input"
                value={odooSh.region}
                onChange={(event) => setOdooSh((p) => ({ ...p, region: event.target.value }))}
              >
                {ODOO_SH_REGIONS.map((region) => (
                  <option key={region.value} value={region.value}>{region.label}</option>
                ))}
              </select>
            </div>
          </div>
        </Section>
      ) : null}
```

- [ ] **Step 5: Typecheck and check by hand**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors.

Then manually (`npm run dev` in frontend and backend):
- Odoo Online still shows its own fields and submits as before.
- Odoo.sh shows the three fields, and the submit button stays disabled until owner and repository are valid.
- Submitting Odoo.sh lands on the project page.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(portal): offer Odoo.sh in Create with AI

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- frontend/app/projects/new/page.tsx
```

---

### Task 6: Project page: Odoo.sh setup panel

**Files:**
- Create: `frontend/components/projects/odoo-sh-setup-panel.tsx`
- Modify: `frontend/app/projects/[projectId]/page.tsx` (the panel switch at lines ~262-270)

**Interfaces:**
- Consumes:
  - `odooShSignupOf`, `odooShRegionLabel` and `ODOO_SH_CREATE_URL` from Task 4;
  - `api.projects.connectOdooSh`;
  - the existing `api.settings.gitCredentials()`, which returns `{ credentials: GitCredential[] }` with fields `id`, `label`, `credentialKind`, `hosts`, `isDefault` and `enabled`.

- [ ] **Step 1: Create the panel**

Create `frontend/components/projects/odoo-sh-setup-panel.tsx`:

```tsx
'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ArrowUpRight, Copy } from 'lucide-react';
import { ApiError, api } from '@/lib/api';
import type { GitCredential } from '@/lib/types';
import { Alert } from '@/components/ui/alert';
import { Section } from '@/components/ui/section';
import { ODOO_SH_CREATE_URL, odooShRegionLabel, type OdooShSignup } from '@/lib/odoo-sh';

/**
 * Finish an assisted Odoo.sh project (ADR-071): the deploy values to copy into
 * odoo.sh, a link that opens it, and the button that connects the repository
 * Odoo.sh created. The token is a registered Git credential, so nothing secret
 * is typed here.
 */
export function OdooShSetupPanel({
  projectId,
  signup,
  onConnected,
}: {
  projectId: string;
  signup: OdooShSignup;
  onConnected: () => void;
}) {
  const [tokens, setTokens] = useState<GitCredential[] | null>(null);
  const [credentialId, setCredentialId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    void api.settings.gitCredentials().then(({ credentials }) => {
      const usable = credentials.filter(
        (c) =>
          c.enabled &&
          c.credentialKind === 'token' &&
          (c.hosts.length === 0 || c.hosts.includes('github.com')),
      );
      setTokens(usable);
      setCredentialId((usable.find((c) => c.isDefault) ?? usable[0])?.id ?? '');
    });
  }, []);

  const connect = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      await api.projects.connectOdooSh(projectId, credentialId ? { credentialId } : {});
      onConnected();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The repository could not be connected.');
    } finally {
      setSubmitting(false);
    }
  }, [projectId, credentialId, onConnected]);

  const checklist = [
    { label: 'GitHub repository', value: 'New repository' },
    { label: 'Owner', value: signup.owner },
    { label: 'Repository name', value: signup.repositoryName },
    { label: 'Odoo version', value: signup.odooVersion },
    { label: 'Hosting location', value: odooShRegionLabel(signup.region) },
  ];

  const copy = (label: string, value: string) => {
    void navigator.clipboard?.writeText(value);
    setCopied(label);
  };

  return (
    <Section
      title="Finish Odoo.sh setup"
      description="The project is deployed at odoo.sh, which also creates its GitHub repository. Cartenz connects that repository once it exists."
    >
      <div className="space-y-8">
        <ol className="list-decimal space-y-1.5 pl-5 text-callout text-content-muted">
          <li>Open odoo.sh and fill the form with the values below.</li>
          <li>Enter your subscription code there and click Deploy. Cartenz never sees the code.</li>
          <li>Come back and connect the repository.</li>
        </ol>

        <dl className="divide-y divide-border rounded-md border border-border">
          {checklist.map((entry) => (
            <div key={entry.label} className="flex items-center justify-between gap-4 px-4 py-2.5">
              <dt className="text-callout text-content-muted">{entry.label}</dt>
              <dd className="flex items-center gap-2 font-mono text-callout">
                {entry.value}
                <button
                  type="button"
                  className="btn-ghost p-1"
                  onClick={() => copy(entry.label, entry.value)}
                  aria-label={`Copy ${entry.label}`}
                >
                  <Copy className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                </button>
              </dd>
            </div>
          ))}
        </dl>
        {copied ? <p className="text-caption text-content-muted" role="status">Copied {copied}.</p> : null}

        <a
          href={ODOO_SH_CREATE_URL}
          target="odoo-sh"
          rel="noreferrer"
          className="btn-secondary inline-flex"
          onClick={(event) => {
            // A sized popup keeps Cartenz visible beside it; a blocked popup
            // falls back to the link's own new-tab behaviour.
            if (window.open(ODOO_SH_CREATE_URL, 'odoo-sh', 'popup,width=1100,height=860')) {
              event.preventDefault();
            }
          }}
        >
          Open Odoo.sh
          <ArrowUpRight className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden="true" />
        </a>

        <div className="space-y-3">
          {tokens && tokens.length === 0 ? (
            <Alert tone="warning">
              No GitHub access token is registered. Add one in{' '}
              <Link href="/settings#git-credentials" className="underline">Settings → Git credentials</Link>{' '}
              (kind: Access token, host: github.com), with access to the repositories of {signup.owner}.
            </Alert>
          ) : null}
          {tokens && tokens.length > 1 ? (
            <div>
              <label htmlFor="sh-token" className="field-label">GitHub token</label>
              <select
                id="sh-token"
                className="field-input"
                value={credentialId}
                onChange={(event) => setCredentialId(event.target.value)}
              >
                {tokens.map((t) => (
                  <option key={t.id} value={t.id}>{t.label}</option>
                ))}
              </select>
            </div>
          ) : null}
          {error ? <Alert tone="error">{error}</Alert> : null}
          <button type="button" className="btn-primary" onClick={() => void connect()} disabled={submitting}>
            {submitting ? 'Connecting…' : 'I have deployed: connect the repository'}
          </button>
        </div>
      </div>
    </Section>
  );
}
```

`Alert` tones are `info | warning | error | success` (`frontend/components/ui/alert.tsx:4`); `GitCredential` is `frontend/lib/types.ts:802`.

- [ ] **Step 2: Wire it into the page**

In `frontend/app/projects/[projectId]/page.tsx`, import `OdooShSetupPanel` and `odooShSignupOf`. Compute `const odooShSignup = odooShSignupOf(project);` next to `odooOnline`. In the panel switch (around line 262), insert before `) : hasInstance ? (`:

```tsx
            ) : odooShSignup && !project.repositoryUrl ? (
              <OdooShSetupPanel
                projectId={project.id}
                signup={odooShSignup}
                onConnected={() => void load()}
              />
```

- [ ] **Step 3: Typecheck**

Run: `cd frontend && npx tsc --noEmit && npm test`
Expected: no errors, all tests PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/components/projects/odoo-sh-setup-panel.tsx
git commit -m "feat(portal): Odoo.sh setup panel with checklist, popup and connect

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- frontend/components/projects/odoo-sh-setup-panel.tsx "frontend/app/projects/[projectId]/page.tsx"
```

---

### Task 7: ADR and end-to-end verification

**Files:**
- Create: `docs/adr/ADR-071-odoo-sh-assisted-creation.md`
- Modify: `docs/adr/ADR-070-odoo-online-assisted-creation.md`. Add only one line under "Consequences", after the "Odoo.sh is not covered" bullet: `  Superseded for Odoo.sh by ADR-071.`

- [ ] **Step 1: Write the ADR**

Follow ADR-070's headings (Context, Decision, Consequences, Verification, Retirement condition). Content comes from the spec plus the four amendments at the top of this plan. Status: Accepted (14 October 2026). It must record these four decisions:
1. Why there is no embedded browser: `x-frame-options: deny` on github.com, and credential handling, as in ADR-052 §9.
2. Odoo.sh creates the repository; Cartenz adopts it.
3. The token comes from Settings → Git credentials, with `GITHUB_TOKEN` as a fallback.
4. `development` is created at connect time.

- [ ] **Step 2: Manual end-to-end run**

1. In Settings → Git credentials, add an Access token for host `github.com`. It must be a classic PAT with `repo` scope, or a fine-grained token with Contents read/write on all repositories of the owner.
2. Create with AI, choose hosting Odoo.sh, owner `BintangLinked`, a new repository name, region Southeast Asia.
3. On the project page, click "Open Odoo.sh", fill the form from the checklist, and click Deploy.
4. Back in Cartenz, click "connect". Expect the panel to disappear, and expect `development` to appear in the GitHub repository and as a development build in Odoo.sh.
5. Submit a small task. Expect a commit on `development` in GitHub and a new Odoo.sh build.
6. Click "connect" on a project whose repository does not exist yet. Expect the "Finish the deploy on Odoo.sh first" message.
7. Create an Odoo Online project. Expect its checklist and connect flow to be unchanged.

Record the outcome in `docs/verification-log.md` in that file's existing format. If step 4 or 5 fails because Odoo.sh created an empty repository or a differently named default branch, stop and report it. Do not work around it here.

- [ ] **Step 3: Commit**

```bash
git add docs/adr/ADR-071-odoo-sh-assisted-creation.md
git commit -m "docs(adr): ADR-071 Odoo.sh assisted creation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- docs/adr/ADR-071-odoo-sh-assisted-creation.md docs/adr/ADR-070-odoo-online-assisted-creation.md docs/verification-log.md docs/superpowers/specs/2026-10-14-odoo-sh-assisted-creation-design.md docs/superpowers/plans/2026-10-14-odoo-sh-assisted-creation.md
```
