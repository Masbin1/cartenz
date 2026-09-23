import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectEnvironments, projects } from '../../core/database/schema';
import { escapeSegment, ProjectCheckoutService } from './project-checkout.service';
import { checkoutPathFor } from '../../agent/git/project-checkout-paths';

/**
 * The one long-lived clone a connected project keeps (ADR-063).
 *
 * Three properties are what this file exists to hold, and each of them is a way
 * this feature can be wrong rather than merely absent:
 *
 *  1. **Nothing a task is working on is ever moved.** A sync fetches, and
 *     fast-forwards only branches nobody has checked out. A branch with a task's
 *     worktree, or with commits of its own, is left exactly where it is - the
 *     alternative loses a commit that exists nowhere else.
 *  2. **The endpoint cannot be used to read an arbitrary ref.** The branch a
 *     caller names is checked against the branches the project declares rather
 *     than being trusted.
 *  3. **A credential never reaches a response or an audit record.** The service
 *     unseals one, hands it to git, and must not carry it anywhere else.
 *
 * The git and database sides are fakes: what is being asserted is the decisions
 * this service makes, and running real git for those would test `git.service` a
 * second time. The real-git behaviour it depends on - that a clone really does
 * bring every branch, that a worktree really does hold a branch exclusively -
 * is covered by `git.service.spec.ts` and `git-pull.spec.ts`.
 */
describe('ProjectCheckoutService', () => {
  const PROJECT_ID = '11111111-2222-3333-4444-555555555555';
  const SECRET_VALUE = 'ghp_this_must_never_be_logged';
  const HEAD = 'a'.repeat(40);
  const REMOTE_HEAD = 'b'.repeat(40);

  let root: string;
  let auditRecords: { event: string; metadata: Record<string, unknown> }[];
  let cloneCalls: Record<string, unknown>[];
  let fetchCalls: unknown[][];
  let refUpdates: { branch: string; to: string; expected: string }[];
  let branches: string[];
  let projectRow: Record<string, unknown> | null;
  let environmentRows: { branch: string }[];
  let worktreeMap: Map<string, string>;
  let gitOverrides: Record<string, unknown>;

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
              return { orderBy: async () => [] };
            },
          }),
        }),
      },
    }) as never;

  const git = () =>
    ({
      clone: async (options: Record<string, unknown>) => {
        cloneCalls.push(options);
        // A clone that actually happened leaves a `.git` directory, which is what
        // every later read of this checkout looks for.
        await mkdir(join(options.destination as string, '.git'), { recursive: true });
        return { headCommit: HEAD, branch: 'Development', durationMs: 1, learnedHostKey: null };
      },
      fetchAll: async (...args: unknown[]) => {
        fetchCalls.push(args);
      },
      hasRef: async (_path: string, ref: string) => {
        if (ref.startsWith('refs/remotes/origin/')) {
          return branches.includes(ref.slice('refs/remotes/origin/'.length));
        }
        return ref.startsWith('refs/heads/');
      },
      headOf: async (_path: string, ref: string) => {
        if (ref === 'HEAD') return HEAD;
        if (ref.startsWith('refs/heads/')) return branches.includes(ref.slice(11)) ? HEAD : null;
        if (ref.startsWith('refs/remotes/origin/')) {
          return branches.includes(ref.slice(20)) ? REMOTE_HEAD : null;
        }
        return null;
      },
      /**
       * A local branch three commits behind its remote and not ahead of it: the
       * shape a sync fast-forwards. `ahead` is the reverse query, so it reads 0.
       */
      countCommits: async (_path: string, from: string, to: string) =>
        from === HEAD && to === REMOTE_HEAD ? 3 : 0,
      countReachable: async () => 827,
      status: async () => ({ clean: true, entries: [] }),
      branchAt: async () => undefined,
      detachAt: async () => undefined,
      worktreeBranches: async () => worktreeMap,
      updateBranchRef: async (_path: string, branch: string, to: string, expected: string) => {
        refUpdates.push({ branch, to, expected });
      },
      ...gitOverrides,
    }) as never;

  const service = (rootPath: string | null = root) =>
    new ProjectCheckoutService(
      config(rootPath),
      database(),
      git(),
      { resolveForHost: async () => ({ secretRef: 'ref-1', kind: 'token' }), hostOf: () => 'github.com' } as never,
      { read: async () => SECRET_VALUE } as never,
      {
        record: async (entry: { event: string; metadata?: Record<string, unknown> }) => {
          auditRecords.push({ event: entry.event, metadata: entry.metadata ?? {} });
        },
      } as never,
      { analyse: async () => ({ modules: [{ technicalName: 'x' }, { technicalName: 'y' }] }) } as never,
      { record: async () => undefined } as never,
    );

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cartenz-checkout-spec-'));
    auditRecords = [];
    cloneCalls = [];
    fetchCalls = [];
    refUpdates = [];
    branches = ['Development', 'Staging'];
    worktreeMap = new Map();
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
      expect(status.cloned).toBe(false);
      // The path is the project's one clone, not one directory per branch.
      expect(status.path).toBe(checkoutPathFor(root, PROJECT_ID));
    });

    it('says a project with no repository has nothing to clone', async () => {
      projectRow = { ...projectRow, repositoryUrl: null };

      const status = await service().status(PROJECT_ID);

      expect(status.reason).toMatch(/no repository/i);
      expect(status.branches).toHaveLength(0);
    });

    it('reports behind as unknown, not zero, before the first fetch', async () => {
      // A branch that has never been compared to the remote is not up to date;
      // saying 0 would claim it is.
      const status = await service().status(PROJECT_ID);

      expect(status.branches[0]?.behind).toBeNull();
      expect(status.branches[0]?.lastSyncedAt).toBeNull();
    });

    it('keeps an existing clone\'s counts and last sync time', async () => {
      await mkdir(join(checkoutPathFor(root, PROJECT_ID), '.git'), { recursive: true });
      await mkdir(join(root, PROJECT_ID, '.cartenz'), { recursive: true });
      await writeFile(
        join(root, PROJECT_ID, '.cartenz', 'Staging.json'),
        JSON.stringify({ branch: 'Staging', lastSyncedAt: '2026-09-23T08:00:00.000Z', commit: HEAD }),
        'utf8',
      );

      // Diverged: three commits each way, which is why a sync will not touch it.
      gitOverrides = { countCommits: async () => 3 };

      const status = await service().status(PROJECT_ID);
      const branch = status.branches.find((entry) => entry.branch === 'Staging');

      expect(status.cloned).toBe(true);
      expect(branch?.exists).toBe(true);
      expect(branch?.commit).toBe(HEAD);
      expect(branch?.behind).toBe(3);
      expect(branch?.ahead).toBe(3);
      expect(branch?.historyDepth).toBe(827);
      expect(branch?.lastSyncedAt).toBe('2026-09-23T08:00:00.000Z');
    });

    it('reports the task holding a branch, and that branch\'s own dirtiness', async () => {
      await mkdir(join(checkoutPathFor(root, PROJECT_ID), '.git'), { recursive: true });
      worktreeMap = new Map([['Staging', '/workspaces/task-1-ws-abcd/repository']]);
      gitOverrides = { status: async () => ({ clean: false, entries: [] }) };

      const status = await service().status(PROJECT_ID);
      const branch = status.branches.find((entry) => entry.branch === 'Staging');

      expect(branch?.inUse).toBe(true);
      expect(branch?.dirty).toBe(true);
    });
  });

  describe('sync', () => {
    it('clones once, every branch, with full history', async () => {
      const result = await service().sync(PROJECT_ID, 'user-1', 'Staging');

      expect(result.outcome).toBe('cloned');
      expect(cloneCalls).toHaveLength(1);
      // Full history is the point of this clone: it is the one a person reads,
      // and `git log` is not answerable from one commit.
      expect(cloneCalls[0]?.full).toBe(true);
      // Every branch in one clone, which is what makes choosing a branch free.
      expect(cloneCalls[0]?.allBranches).toBe(true);
      expect(cloneCalls[0]?.destination).toBe(checkoutPathFor(root, PROJECT_ID));
      // `depth` is a task concern and must not be forced onto this clone.
      expect(cloneCalls[0]?.depth).toBeUndefined();
    });

    it('fetches every branch on a sync, rather than pulling one', async () => {
      await mkdir(join(checkoutPathFor(root, PROJECT_ID), '.git'), { recursive: true });

      const result = await service().sync(PROJECT_ID, 'user-1', 'Staging');

      expect(fetchCalls).toHaveLength(1);
      expect(cloneCalls).toHaveLength(0);
      expect(result.outcome).toBe('fast_forwarded');
    });

    it('re-reads the project memory from what it fetched', async () => {
      const result = await service().sync(PROJECT_ID, 'user-1', 'Staging');

      expect(result.modules).toBe(2);
    });

    it('never moves a branch a running task has checked out', async () => {
      await mkdir(join(checkoutPathFor(root, PROJECT_ID), '.git'), { recursive: true });
      worktreeMap = new Map([['Staging', '/workspaces/task-1-ws-abcd/repository']]);

      const result = await service().sync(PROJECT_ID, 'user-1', 'Staging');

      // Development was fast-forwarded; Staging, held by a task, was not.
      expect(refUpdates.map((update) => update.branch)).toEqual(['Development']);
      expect(result.message).toMatch(/in use by a running task/);
    });

    it('fast-forwards with a compare-and-swap on the commit it saw', async () => {
      await mkdir(join(checkoutPathFor(root, PROJECT_ID), '.git'), { recursive: true });

      await service().sync(PROJECT_ID, 'user-1', 'Staging');

      // The old value is passed so a branch that moved in between is not
      // overwritten - the point of not holding a lock across the whole sync.
      expect(refUpdates.every((update) => update.expected === HEAD)).toBe(true);
      expect(refUpdates.every((update) => update.to === REMOTE_HEAD)).toBe(true);
    });

    it('reports a refusal as a refusal, with git\'s own words', async () => {
      await mkdir(join(checkoutPathFor(root, PROJECT_ID), '.git'), { recursive: true });
      const { GitPullRefusedError } = await import('../../agent/git/git.service');
      gitOverrides = {
        fetchAll: async () => {
          throw new GitPullRefusedError('diverged', 'the branches have diverged; a person must decide');
        },
      };

      const result = await service().sync(PROJECT_ID, 'user-1', 'Staging');

      expect(result.outcome).toBe('refused');
      expect(result.message).toMatch(/diverged/);
      expect(auditRecords.some((record) => record.metadata.outcome === 'refused')).toBe(true);
    });

    it('reports anything else as a failure', async () => {
      await mkdir(join(checkoutPathFor(root, PROJECT_ID), '.git'), { recursive: true });
      gitOverrides = {
        fetchAll: async () => {
          throw new Error('remote hung up');
        },
      };

      const result = await service().sync(PROJECT_ID, 'user-1', 'Staging');

      expect(result.outcome).toBe('failed');
      expect(result.message).toBe('remote hung up');
    });

    it('refuses a branch the project does not declare, without cloning it', async () => {
      // Otherwise this endpoint is a way to make the platform read an arbitrary
      // ref of a repository it can authenticate to, and record it as this
      // project's code.
      const result = await service().sync(PROJECT_ID, 'user-1', '../../etc');

      expect(result.outcome).toBe('refused');
      expect(result.message).toMatch(/not one of this project's branches/);
      expect(cloneCalls).toHaveLength(0);
      expect(fetchCalls).toHaveLength(0);
    });

    it('says so rather than failing when the remote has no such branch', async () => {
      branches = ['Development'];

      const result = await service().sync(PROJECT_ID, 'user-1', 'Staging');

      expect(result.outcome).toBe('refused');
      expect(result.message).toMatch(/no branch "Staging"/);
    });

    it('serialises two syncs of one project instead of letting them contend', async () => {
      await mkdir(join(checkoutPathFor(root, PROJECT_ID), '.git'), { recursive: true });
      const order: string[] = [];
      let running = 0;
      let overlapped = false;
      gitOverrides = {
        fetchAll: async (...args: unknown[]) => {
          running += 1;
          if (running > 1) overlapped = true;
          order.push('start');
          await new Promise((resolve) => setTimeout(resolve, 20));
          order.push('end');
          fetchCalls.push(args);
          running -= 1;
        },
      };
      const shared = service();

      await Promise.all([
        shared.sync(PROJECT_ID, 'user-1', 'Staging'),
        shared.sync(PROJECT_ID, 'user-2', 'Staging'),
      ]);

      // Both ran, one after the other: git ref locks are per-repository, and a
      // second concurrent fetch fails on them rather than waiting.
      expect(fetchCalls).toHaveLength(2);
      expect(overlapped).toBe(false);
      expect(order).toEqual(['start', 'end', 'start', 'end']);
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
    it('re-reads the clone without contacting the remote', async () => {
      await mkdir(join(checkoutPathFor(root, PROJECT_ID), '.git'), { recursive: true });

      const result = await service().analyze(PROJECT_ID, 'user-1', 'Staging');

      expect(result.branch).toBe('Staging');
      expect(result.modules).toBe(2);
      expect(fetchCalls).toHaveLength(0);
      expect(auditRecords.some((record) => record.event === 'project.checkout_analysed')).toBe(true);
    });

    it('says to sync first when there is nothing on disk to read', async () => {
      const result = await service().analyze(PROJECT_ID, 'user-1');

      expect(result.branch).toBeNull();
      expect(result.modules).toBeNull();
      expect(result.message).toMatch(/sync/i);
    });

    it('refuses a branch the project does not declare', async () => {
      await mkdir(join(checkoutPathFor(root, PROJECT_ID), '.git'), { recursive: true });

      const result = await service().analyze(PROJECT_ID, 'user-1', '../../etc');

      expect(result.branch).toBeNull();
      expect(result.message).toMatch(/not one of this project's branches/);
    });
  });

  describe('existingCheckout', () => {
    it('is null until the clone exists, which is what keeps the fallback intact', async () => {
      expect(await service().existingCheckout(PROJECT_ID)).toBeNull();

      await mkdir(join(checkoutPathFor(root, PROJECT_ID), '.git'), { recursive: true });

      expect(await service().existingCheckout(PROJECT_ID)).toBe(checkoutPathFor(root, PROJECT_ID));
    });

    it('is null when this deployment keeps no checkouts', async () => {
      expect(await service(null).existingCheckout(PROJECT_ID)).toBeNull();
    });
  });
});

/**
 * A branch name becomes a file name, and `feature/PAY-12` is a legal branch name
 * that is not a legal single path segment. The property asserted is the one that
 * matters: no output can introduce a separator, so a name can never place a
 * state file outside the project's own directory.
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
