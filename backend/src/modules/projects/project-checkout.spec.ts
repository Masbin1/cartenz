import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitPullRefusedError } from '../../agent/git/git.service';
import { projectEnvironments, projects } from '../../core/database/schema';
import { escapeSegment, ProjectCheckoutService } from './project-checkout.service';

/**
 * The long-lived clone a connected project keeps (ADR-063).
 *
 * Three properties are what this file exists to hold, and each of them is a way
 * this feature can be wrong rather than merely absent:
 *
 *  1. A refusal is not a failure. A checkout with local edits or a diverged
 *     branch is a state a person resolves; reporting it as an error invites
 *     someone to \"retry\" something that will refuse identically.
 *  2. The endpoint cannot be used to clone an arbitrary ref. The branch a caller
 *     names becomes a directory name, so it is checked against the branches the
 *     project actually declares rather than being trusted.
 *  3. A credential never reaches a response or an audit record. The service
 *     unseals one, hands it to git, and the metadata written afterwards must not
 *     contain it.
 *
 * The git and database sides are fakes: what is being asserted is the decisions
 * this service makes, and running real git for those would test `git.service`
 * a second time. The real-git behaviour it depends on is covered by
 * `git-pull.spec.ts`.
 */
describe('ProjectCheckoutService', () => {
  const PROJECT_ID = '11111111-2222-3333-4444-555555555555';
  const SECRET_VALUE = 'ghp_this_must_never_be_logged';
  const HEAD = 'a'.repeat(40);

  let root: string;
  let auditRecords: { event: string; metadata: Record<string, unknown> }[];
  let cloneCalls: Record<string, unknown>[];
  let pullCalls: unknown[][];
  let projectRow: Record<string, unknown> | null;
  let environmentRows: { branch: string }[];
  let connectionRows: Record<string, unknown>[];
  let gitOverrides: Record<string, unknown>;

  const commitHash = (suffix: string) => suffix.padEnd(40, '0');

  const config = (rootPath: string | null) =>
    ({
      checkouts: { root: rootPath, reuse: false },
      git: { cloneDepth: 1, sshHostKeyPolicy: 'accept-new' },
    }) as never;

  const database = () =>
    ({
      db: {
        select: () => ({
          from: (table: unknown) => ({
            where: () => {
              if (table === projects) {
                return { limit: async () => (projectRow ? [projectRow] : []) };
              }
              if (table === projectEnvironments) {
                return {
                  then: (resolve: (rows: unknown) => unknown) =>
                    Promise.resolve(environmentRows).then(resolve),
                };
              }
              return { orderBy: async () => connectionRows };
            },
          }),
        }),
      },
    }) as never;

  const git = () =>
    ({
      clone: async (options: Record<string, unknown>) => {
        cloneCalls.push(options);
        // A clone that actually happened leaves a `.git`, which is what every
        // later read of this checkout looks for.
        await mkdir(join(options.destination as string, '.git'), { recursive: true });
        return { headCommit: HEAD, branch: 'Staging', durationMs: 1, learnedHostKey: null };
      },
      pullFastForward: async (...args: unknown[]) => {
        pullCalls.push(args);
        return { outcome: 'fast_forwarded', commits: 3, before: 'b'.repeat(40), after: HEAD, filesChanged: 4 };
      },
      headOf: async (_path: string, ref: string) =>
        ref === 'HEAD' ? HEAD : commitHash('c'),
      countCommits: async () => 3,
      countReachable: async () => 128,
      status: async () => ({ clean: true, entries: [] }),
      ...gitOverrides,
    }) as never;

  const service = (rootPath: string | null = root) =>
    new ProjectCheckoutService(
      config(rootPath),
      database(),
      git(),
      { resolveForHost: async () => ({ secretRef: 'ref-1', kind: 'token' }), hostOf: () => 'github.com' } as never,
      { read: async () => SECRET_VALUE } as never,
      { record: async (entry: { event: string; metadata?: Record<string, unknown> }) => {
          auditRecords.push({ event: entry.event, metadata: entry.metadata ?? {} });
        } } as never,
      { analyse: async () => ({ modules: [{ technicalName: 'x' }, { technicalName: 'y' }] }) } as never,
      { record: async () => undefined } as never,
    );

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cartenz-checkout-spec-'));
    auditRecords = [];
    cloneCalls = [];
    pullCalls = [];
    connectionRows = [];
    environmentRows = [{ branch: 'Staging' }];
    gitOverrides = {};
    projectRow = {
      name: 'omnisurge',
      defaultBranch: 'Development',
      repositoryUrl: 'https://github.com/OmnisurgeOdoo/Odoo.git',
      gitCredentialId: null,
      gitUsername: null,
      gitTransport: 'auto',
    };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe('when the deployment keeps no checkouts', () => {
    it('says so, and says what to set, rather than reporting an empty project', async () => {
      const status = await service(null).status(PROJECT_ID);

      expect(status.enabled).toBe(false);
      expect(status.branches).toEqual([]);
      expect(status.reason).toMatch(/PROJECT_CHECKOUT_ROOT/);
    });

    it('refuses a sync with the same explanation', async () => {
      const result = await service(null).sync(PROJECT_ID, 'user-1');

      expect(result.outcome).toBe('refused');
      expect(result.message).toMatch(/PROJECT_CHECKOUT_ROOT/);
      expect(cloneCalls).toHaveLength(0);
    });
  });

  describe('status', () => {
    it('reports the default branch and each environment branch, deduplicated', async () => {
      environmentRows = [{ branch: 'Staging' }, { branch: 'Development' }];

      const status = await service().status(PROJECT_ID);

      expect(status.enabled).toBe(true);
      expect(status.branches.map((branch) => branch.branch).sort()).toEqual([
        'Development',
        'Staging',
      ]);
      expect(status.branches.every((branch) => !branch.exists)).toBe(true);
    });

    it('says a project with no repository has nothing to clone', async () => {
      projectRow = { ...projectRow, repositoryUrl: null };

      const status = await service().status(PROJECT_ID);

      expect(status.reason).toMatch(/no repository/i);
      expect(status.branches).toHaveLength(0);
    });

    it('reports behind as unknown, not zero, before the first fetch', async () => {
      // A checkout that has never been compared to the remote is not up to
      // date; saying 0 would claim it is.
      const status = await service().status(PROJECT_ID);

      expect(status.branches[0]?.behind).toBeNull();
      expect(status.branches[0]?.lastSyncedAt).toBeNull();
    });

    it('keeps an existing clone\'s behind count and last sync time', async () => {
      const path = join(root, PROJECT_ID, 'Staging');
      await mkdir(join(path, '.git'), { recursive: true });
      await mkdir(join(root, PROJECT_ID, '.cartenz'), { recursive: true });
      await writeFile(
        join(root, PROJECT_ID, '.cartenz', 'Staging.json'),
        JSON.stringify({ branch: 'Staging', lastSyncedAt: '2026-09-23T08:00:00.000Z', commit: HEAD }),
        'utf8',
      );

      const status = await service().status(PROJECT_ID);
      const branch = status.branches.find((entry) => entry.branch === 'Staging');

      expect(branch?.exists).toBe(true);
      expect(branch?.commit).toBe(HEAD);
      expect(branch?.behind).toBe(3);
      expect(branch?.historyDepth).toBe(128);
      expect(branch?.lastSyncedAt).toBe('2026-09-23T08:00:00.000Z');
    });
  });

  describe('sync', () => {
    it('clones a branch that is not on disk yet, with full history', async () => {
      const result = await service().sync(PROJECT_ID, 'user-1', 'Staging');

      expect(result.outcome).toBe('cloned');
      expect(cloneCalls).toHaveLength(1);
      // Full history is the point of a checkout: it is the clone a person
      // reads, and `git log` is not answerable from one commit.
      expect(cloneCalls[0]?.full).toBe(true);
      expect(cloneCalls[0]?.branch).toBe('Staging');
      expect(cloneCalls[0]?.destination).toBe(join(root, PROJECT_ID, 'Staging'));
      // `depth` is a task concern and must not be forced onto the checkout.
      expect(cloneCalls[0]?.depth).toBeUndefined();
    });

    it('re-reads the project memory from what it cloned', async () => {
      const result = await service().sync(PROJECT_ID, 'user-1', 'Staging');

      expect(result.modules).toBe(2);
    });

    it('fast-forwards a branch that is already checked out', async () => {
      await mkdir(join(root, PROJECT_ID, 'Staging', '.git'), { recursive: true });

      const result = await service().sync(PROJECT_ID, 'user-1', 'Staging');

      expect(result.outcome).toBe('fast_forwarded');
      expect(result.message).toMatch(/3 commits?/);
      expect(cloneCalls).toHaveLength(0);
      expect(pullCalls).toHaveLength(1);
    });

    it('reports "already up to date" as a success, not a failure', async () => {
      await mkdir(join(root, PROJECT_ID, 'Staging', '.git'), { recursive: true });
      gitOverrides = {
        pullFastForward: async () => ({
          outcome: 'up_to_date',
          commits: 0,
          before: HEAD,
          after: HEAD,
          filesChanged: 0,
        }),
      };

      const result = await service().sync(PROJECT_ID, 'user-1', 'Staging');

      expect(result.outcome).toBe('up_to_date');
      expect(result.message).toMatch(/up to date/i);
    });

    it('reports a refusal as a refusal, with git\'s own words', async () => {
      await mkdir(join(root, PROJECT_ID, 'Staging', '.git'), { recursive: true });
      gitOverrides = {
        pullFastForward: async () => {
          throw new GitPullRefusedError('diverged', 'the branches have diverged; a person must decide');
        },
      };

      const result = await service().sync(PROJECT_ID, 'user-1', 'Staging');

      expect(result.outcome).toBe('refused');
      expect(result.message).toMatch(/diverged/);
      expect(auditRecords.some((record) => record.metadata.outcome === 'refused')).toBe(true);
    });

    it('reports anything else as a failure', async () => {
      await mkdir(join(root, PROJECT_ID, 'Staging', '.git'), { recursive: true });
      gitOverrides = {
        pullFastForward: async () => {
          throw new Error('remote hung up');
        },
      };

      const result = await service().sync(PROJECT_ID, 'user-1', 'Staging');

      expect(result.outcome).toBe('failed');
      expect(result.message).toBe('remote hung up');
    });

    it('refuses a branch the project does not declare, without cloning it', async () => {
      // Otherwise this endpoint is a way to make the platform clone an
      // arbitrary ref of a repository it can authenticate to, into a directory
      // named by the caller.
      const result = await service().sync(PROJECT_ID, 'user-1', '../../etc');

      expect(result.outcome).toBe('refused');
      expect(result.message).toMatch(/not one of this project's branches/);
      expect(cloneCalls).toHaveLength(0);
      // Nothing was created under the project at all: the refusal happened
      // before a path was derived from the name the caller supplied.
      expect(existsSync(join(root, PROJECT_ID))).toBe(false);
    });

    it('never writes the credential value into an audit record', async () => {
      await service().sync(PROJECT_ID, 'user-1', 'Staging');

      const serialised = JSON.stringify(auditRecords);
      expect(serialised).not.toContain(SECRET_VALUE);
      expect(serialised).not.toContain('ghp_');
      // The events still say what happened, so the trail is useful as well as
      // clean.
      expect(auditRecords.some((record) => record.event === 'project.checkout_synced')).toBe(true);
    });
  });

  describe('analyze', () => {
    it('re-reads an existing clone without contacting the remote', async () => {
      await mkdir(join(root, PROJECT_ID, 'Staging', '.git'), { recursive: true });

      const result = await service().analyze(PROJECT_ID, 'user-1');

      expect(result.branch).toBe('Staging');
      expect(result.modules).toBe(2);
      expect(pullCalls).toHaveLength(0);
      expect(auditRecords.some((record) => record.event === 'project.checkout_analysed')).toBe(true);
    });

    it('says to sync first when there is nothing on disk to read', async () => {
      const result = await service().analyze(PROJECT_ID, 'user-1');

      expect(result.branch).toBeNull();
      expect(result.modules).toBeNull();
      expect(result.message).toMatch(/sync one first/i);
    });
  });
});

/**
 * A branch name becomes a directory name, and `feature/PAY-12` is a legal
 * branch name that is not a legal single path segment. The property asserted is
 * the one that matters: no output can introduce a separator, so a name can never
 * place a checkout outside the project's own directory.
 */
describe('escapeSegment', () => {
  it('keeps the characters a branch name legitimately uses', () => {
    expect(escapeSegment('Development')).toBe('Development');
    expect(escapeSegment('release-2.0_rc1')).toBe('release-2.0_rc1');
  });

  it('flattens a branch that would otherwise add a path level', () => {
    expect(escapeSegment('feature/PAY-12')).toBe('feature-PAY-12');
    expect(escapeSegment('../../etc/passwd')).toBe('..-..-etc-passwd');
  });

  it('never emits a separator or a null byte', () => {
    for (const name of ['a/b/c', 'a\\b', '..', '.', 'a\u0000b', 'feature/x/../y']) {
      const escaped = escapeSegment(name);
      expect(escaped).not.toMatch(/[/\\\u0000]/);
      expect(escaped.length).toBeGreaterThan(0);
    }
  });

  it('bounds the length so a name cannot become an unusably long path', () => {
    expect(escapeSegment('x'.repeat(500)).length).toBeLessThanOrEqual(128);
  });
});
