import { TaskRepository } from './task-repository';
import {
  agentTasks,
  approvals,
  projectConnections,
  projectEnvironments,
} from '../core/database/schema';
import type { DatabaseService } from '../core/database/database.service';
import type { AuditService } from '../core/audit/audit.service';
import type { TaskEventPublisher } from '../core/events/task-event-publisher.service';
import { GitCredentialsService } from '../modules/settings/git-credentials.service';
import type { SecretsProvider } from '../core/secrets/secrets.provider';

/**
 * Snapshot's three-tier credential resolution (ADR-059).
 *
 * This is the exact failure task_221242 hit: the project's remote was HTTPS, its
 * only stored credentials were SSH keys, and `credentialRef` came back null — so
 * the push ran with no credential at all and died on `could not read Username
 * for 'https://github.com'`. The fix adds a project-level override (tier 1) and
 * a deployment-default fallback (tier 3, ADR-058). This asserts each tier wins
 * in the order it is documented to.
 */
describe('TaskRepository.snapshot — credential resolution (ADR-059)', () => {
  type CredentialRow = {
    id: string;
    label: string;
    credentialKind: 'token' | 'ssh_key';
    hosts: string[];
    isDefault: boolean;
    enabled: boolean;
    secretRef: string;
  };

  const baseTaskRow = {
    taskId: 'task-1',
    reference: 'task_1',
    projectId: 'project-1',
    projectName: 'Demo',
    prompt: 'do the thing',
    attachedDocumentIds: [],
    kind: 'change',
    status: 'analysing',
    branch: null,
    baseCommit: null,
    plan: null,
    odooVersion: '18.0',
    odooEdition: 'community',
    repositoryUrl: 'https://github.com/acme/repo.git',
    defaultBranch: 'main',
    projectType: 'existing_repo',
    agentPermissions: null,
    localProviderOnly: false,
    environmentConfig: null,
    environmentId: null,
    gitTransport: 'auto',
    gitCredentialId: null as string | null,
    gitUsername: null as string | null,
  };

  /**
   * A database stand-in that answers the four selects `snapshot` issues, keyed
   * by table identity rather than by name. Minimal on purpose: the assertion is
   * about which credential tier wins, not about the SQL.
   */
  const makeDatabase = (options: {
    taskRow?: typeof baseTaskRow;
    connections?: Record<string, unknown>[];
    credentials?: CredentialRow[];
  }) => {
    const taskRow = options.taskRow ?? baseTaskRow;
    const connections = options.connections ?? [];
    const credentials = options.credentials ?? [];

    const database = {
      db: {
        select: () => ({
          from: (table: unknown) => ({
            // The task row: .innerJoin().where().limit()
            innerJoin: () => ({
              where: () => ({
                limit: async () => [taskRow],
              }),
            }),
            // Every other select: .where(), then either .limit() or .orderBy()
            where: () => ({
              limit: async () => {
                if (table === projectEnvironments) {
                  return taskRow.environmentId
                    ? [
                        {
                          name: 'Development',
                          branch: 'main',
                          kind: 'development',
                        },
                      ]
                    : [];
                }
                return [];
              },
              orderBy: async () => {
                if (table === projectConnections) return connections;
                if (table === approvals) return [];
                if (table === agentTasks) return [];
                return [];
              },
            }),
          }),
        }),
      },
    } as unknown as DatabaseService;

    void credentials;
    return database;
  };

  /**
   * A real service over a stand-in registry, so the resolution order is real.
   *
   * `resolveForHost` is stubbed to the behaviour documented on it — an explicit
   * id must match an enabled row, otherwise the default for the host is offered —
   * because the alternative is re-implementing drizzle's `where` in a mock, which
   * tests the mock. The rule itself is asserted in git-credentials.spec.ts; what
   * this file is about is which tier TaskRepository asks.
   */
  const makeGitCredentials = (rows: CredentialRow[]) => {
    const secrets: SecretsProvider = {
      write: async () => ({ ref: 'unused' }),
      read: async (ref) => `unsealed:${ref}`,
      destroy: async () => {},
      exists: async () => true,
    };

    const service = new GitCredentialsService(
      {} as DatabaseService,
      {} as AuditService,
      secrets,
    );

    const resolve = (row: CredentialRow) => ({
      kind: row.credentialKind,
      value: `unsealed:${row.secretRef}`,
      credentialId: row.id,
      secretRef: row.secretRef,
    });

    jest.spyOn(service, 'list').mockResolvedValue(rows as never);
    jest
      .spyOn(service, 'resolveForHost')
      .mockImplementation(async (options: { credentialId?: string | null; host?: string | null }) => {
        if (options.credentialId) {
          const row = rows.find((entry) => entry.id === options.credentialId && entry.enabled);
          return row ? resolve(row) : null;
        }
        const row = rows.find(
          (entry) =>
            entry.isDefault &&
            entry.enabled &&
            (entry.hosts.length === 0 ||
              (options.host !== null &&
                options.host !== undefined &&
                entry.hosts.includes(options.host.toLowerCase()))),
        );
        return row ? resolve(row) : null;
      });

    return service;
  };

  const build = (options: {
    taskRow?: typeof baseTaskRow;
    connections?: Record<string, unknown>[];
    credentials?: CredentialRow[];
  }) =>
    new TaskRepository(
      makeDatabase(options),
      {} as TaskEventPublisher,
      {} as AuditService,
      makeGitCredentials(options.credentials ?? []),
    );

  const connection = (overrides: Record<string, unknown> = {}) => ({
    secretRef: 'secret:connection-token',
    credentialKind: 'token',
    sshHostKey: null,
    metadata: {},
    connectionType: 'github',
    createdAt: new Date('2024-01-01'),
    ...overrides,
  });

  const credential = (overrides: Partial<CredentialRow> = {}): CredentialRow => ({
    id: 'cred-1',
    label: 'GitHub default',
    credentialKind: 'token',
    hosts: [],
    isDefault: true,
    enabled: true,
    secretRef: 'secret:default-token',
    ...overrides,
  });

  it('tier 3: falls back to the deployment default when nothing project-level is set', async () => {
    const repository = build({
      connections: [],
      credentials: [credential()],
    });

    const snapshot = await repository.snapshot('task-1');

    expect(snapshot.credentialRef).toBe('secret:default-token');
    expect(snapshot.credentialKind).toBe('token');
  });

  it('tier 2: a connection credential wins over the deployment default', async () => {
    const repository = build({
      connections: [connection()],
      credentials: [credential()],
    });

    const snapshot = await repository.snapshot('task-1');

    expect(snapshot.credentialRef).toBe('secret:connection-token');
  });

  it("tier 1: the project's own choice wins over both a connection and the default", async () => {
    const repository = build({
      taskRow: { ...baseTaskRow, gitCredentialId: 'cred-2' },
      connections: [connection()],
      credentials: [
        credential(),
        credential({
          id: 'cred-2',
          label: 'Chosen token',
          isDefault: false,
          secretRef: 'secret:chosen-token',
        }),
      ],
    });

    const snapshot = await repository.snapshot('task-1');

    expect(snapshot.credentialRef).toBe('secret:chosen-token');
  });

  /**
   * A stale project-level choice must not brick the project: the credential row
   * can be deleted after being chosen, and the snapshot then falls through to
   * whatever the next tier offers rather than failing outright.
   */
  it('tier 1 falls through when the chosen credential no longer resolves', async () => {
    const repository = build({
      taskRow: { ...baseTaskRow, gitCredentialId: 'cred-deleted' },
      connections: [],
      credentials: [credential()],
    });

    const snapshot = await repository.snapshot('task-1');

    // `resolveForHost({ credentialId })` finds nothing, so tier 3 is reached.
    expect(snapshot.credentialRef).toBe('secret:default-token');
  });

  it('resolves to no credential when no tier offers one', async () => {
    const repository = build({ connections: [], credentials: [] });

    const snapshot = await repository.snapshot('task-1');

    expect(snapshot.credentialRef).toBeNull();
  });

  /**
   * The project's transport choice reaches the URL the clone actually uses —
   * the whole point of the setting, and invisible if only the column is written.
   */
  it('rewrites the repository URL to the project\'s chosen transport', async () => {
    const repository = build({
      taskRow: { ...baseTaskRow, gitTransport: 'ssh' },
      connections: [],
      credentials: [],
    });

    const snapshot = await repository.snapshot('task-1');

    expect(snapshot.repositoryUrl).toBe('ssh://git@github.com/acme/repo.git');
  });

  it('leaves the repository URL alone under auto', async () => {
    const repository = build({ connections: [], credentials: [] });

    const snapshot = await repository.snapshot('task-1');

    expect(snapshot.repositoryUrl).toBe('https://github.com/acme/repo.git');
  });
});
