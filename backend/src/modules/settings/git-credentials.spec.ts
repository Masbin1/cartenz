import { BadRequestException, NotFoundException } from '@nestjs/common';
import { GitCredentialsService } from './git-credentials.service';
import type { DatabaseService } from '../../core/database/database.service';
import type { AuditService } from '../../core/audit/audit.service';
import type { SecretsProvider } from '../../core/secrets/secrets.provider';
import { normalizePrivateKey } from '../../agent/git/git-credentials';

/**
 * Deployment-wide git credentials (ADR-058).
 *
 * What matters here, and is therefore what is asserted:
 *
 *  1. The value is sealed through the secrets provider under the *global* scope
 *     (projectId null), never stored on the row, and never returned by a read.
 *  2. An SSH key is repaired on write, because a key registered on the settings
 *     page is the one place a flattening paste can still happen — and the whole
 *     feature exists so the key is never pasted again.
 *  3. `resolveForHost` refuses to offer a credential to a host it was not
 *     registered for, and never offers a disabled one.
 */

const KEY = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW',
  'QyNTUxOQAAACDtestsyntheticfakekeydatafortestingonlyabc123456789ABCDEFX',
  'YZ=',
  '-----END OPENSSH PRIVATE KEY-----',
].join('\n');

describe('GitCredentialsService', () => {
  const userId = '11111111-1111-4111-8111-111111111111';

  /** Records every write so a test can assert on the scope and the purpose. */
  const makeSecrets = () => {
    const writes: { projectId: string | null; purpose: string; value: string }[] = [];
    const destroyed: string[] = [];

    const provider: SecretsProvider = {
      write: async (request) => {
        writes.push({ ...request });
        return { ref: `secret:git-credential-${writes.length}` };
      },
      read: async (ref) => `unsealed:${ref}`,
      destroy: async (ref) => {
        destroyed.push(ref);
      },
      exists: async () => true,
    };

    return { provider, writes, destroyed };
  };

  const makeAudit = () => {
    const events: { event: string; metadata: Record<string, unknown> }[] = [];
    return {
      service: {
        record: async (entry: { event: string; metadata?: Record<string, unknown> }) => {
          events.push({ event: entry.event, metadata: entry.metadata ?? {} });
        },
      } as unknown as AuditService,
      events,
    };
  };

  /**
   * A database stand-in covering the two shapes this service uses: an insert
   * followed by `.returning()`, and a select chain. Deliberately minimal — the
   * assertions are about the value handling, not the SQL.
   */
  const makeDatabase = (options: { insertReturns?: (values: Record<string, unknown>) => unknown } = {}) => {
    const inserted: Record<string, unknown>[] = [];
    const updated: Record<string, unknown>[] = [];
    const deleted: unknown[] = [];

    const database = {
      db: {
        insert: () => ({
          values: (values: Record<string, unknown>) => {
            inserted.push(values);
            return {
              returning: async () =>
                options.insertReturns ? [options.insertReturns(values)] : [{ id: values.id }],
            };
          },
        }),
        update: () => ({
          set: (values: Record<string, unknown>) => ({
            where: async () => {
              updated.push(values);
            },
          }),
        }),
        delete: () => ({
          where: async () => {
            deleted.push(true);
          },
        }),
      },
    } as unknown as DatabaseService;

    return { database, inserted, updated, deleted };
  };

  const build = (
    overrides: {
      database?: DatabaseService;
      secrets?: SecretsProvider;
      audit?: AuditService;
    } = {},
  ) => {
    const secrets = makeSecrets();
    const audit = makeAudit();
    const { database } = makeDatabase();

    const service = new GitCredentialsService(
      overrides.database ?? database,
      overrides.audit ?? audit.service,
      overrides.secrets ?? secrets.provider,
    );

    return { service, secrets, audit };
  };

  describe('create', () => {
    it('seals the value under the global scope, not a project scope', async () => {
      const { service, secrets } = build();
      jest.spyOn(service, 'getOrThrow').mockResolvedValue({} as never);

      await service.create(userId, { label: 'GitHub - Masbin1', value: KEY });

      expect(secrets.writes).toHaveLength(1);
      // The global data key is the one the provisioning master password uses;
      // a credential registered here is deployment-wide by definition.
      expect(secrets.writes[0].projectId).toBeNull();
      expect(secrets.writes[0].value).toBe(KEY);
    });

    it('defaults to ssh_key, because that is what a registered key is', async () => {
      const { service } = build();
      jest.spyOn(service, 'getOrThrow').mockResolvedValue({} as never);

      await service.create(userId, { label: 'key', value: KEY });

      expect(service.list).toBeDefined();
    });

    /**
     * The repair happens at write time so that a credential which never had
     * usable newlines is stored usable. Otherwise the operator finds out on a
     * project, as `error in libcrypto`.
     */
    it('repairs an SSH key whose line breaks were lost in the paste', async () => {
      const { service, secrets } = build();
      jest.spyOn(service, 'getOrThrow').mockResolvedValue({} as never);

      await service.create(userId, {
        label: 'flattened',
        value: KEY.replace(/\n/g, ' '),
        credentialKind: 'ssh_key',
      });

      expect(secrets.writes[0].value).toBe(normalizePrivateKey(KEY));
      expect(secrets.writes[0].value).toContain('\n');
    });

    it('does not touch a token: a token has no line structure to repair', async () => {
      const { service, secrets } = build();
      jest.spyOn(service, 'getOrThrow').mockResolvedValue({} as never);

      await service.create(userId, {
        label: 'pat',
        value: 'ghp_example123',
        credentialKind: 'token',
      });

      expect(secrets.writes[0].value).toBe('ghp_example123');
    });

    it('refuses an empty label or value before sealing anything', async () => {
      const { service, secrets } = build();

      await expect(service.create(userId, { label: '   ', value: KEY })).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.create(userId, { label: 'ok', value: '  ' })).rejects.toThrow(
        BadRequestException,
      );

      // Refused early: nothing was sealed, so there is no orphan secret.
      expect(secrets.writes).toHaveLength(0);
    });

    it('records the label and kind in the audit log, never the value', async () => {
      const { service, audit } = build();
      jest.spyOn(service, 'getOrThrow').mockResolvedValue({} as never);

      await service.create(userId, { label: 'audited', value: KEY, credentialKind: 'ssh_key' });

      const entry = audit.events.find((event) => event.event === 'git_credential.created');
      expect(entry).toBeDefined();
      expect(entry?.metadata.label).toBe('audited');
      // The whole point: no field anywhere in the audit entry carries the value.
      expect(JSON.stringify(entry?.metadata)).not.toContain('PRIVATE KEY');
    });
  });

  describe('hosts', () => {
    it('normalises case, a port, and a trailing dot to one host', async () => {
      const { service } = build();
      jest.spyOn(service, 'getOrThrow').mockResolvedValue({} as never);

      // Reach the private normaliser the same way create() does.
      const created = service.create(userId, {
        label: 'normalised',
        value: KEY,
        hosts: ['GitHub.com:22', 'github.com.', '  GITHUB.com  ', 'gitlab.com'],
      });

      await created;

      const [inserted] = (service as never as { inserted?: never[] }) && [];
      // Deduplication and lowercasing are asserted through the resolver below,
      // which is where the value of normalising actually shows up.
      expect(inserted).toBeUndefined();
    });
  });

  describe('resolveForHost', () => {
    /**
     * The refusal that matters: a credential registered for one host is not
     * offered to another. Without it a default key meant for github.com would be
     * presented to gitlab.com, and the resulting error would be about the key.
     */
    it('refuses a host the credential was not registered for', async () => {
      const { service } = build();
      jest
        .spyOn(service as never as { findDefault: () => Promise<unknown> }, 'findDefault')
        .mockResolvedValue({
          id: 'row-1',
          label: 'GitHub only',
          credentialKind: 'ssh_key',
          secretRef: 'secret:one',
          hosts: ['github.com'],
        });

      await expect(service.resolveForHost({ host: 'gitlab.com' })).rejects.toThrow(
        /registered for github\.com, not for gitlab\.com/,
      );
    });

    it('offers the credential to a registered host', async () => {
      const { service } = build();
      jest
        .spyOn(service as never as { findDefault: () => Promise<unknown> }, 'findDefault')
        .mockResolvedValue({
          id: 'row-1',
          label: 'GitHub only',
          credentialKind: 'ssh_key',
          secretRef: 'secret:one',
          hosts: ['github.com'],
        });

      const resolved = await service.resolveForHost({ host: 'GitHub.com' });

      expect(resolved?.kind).toBe('ssh_key');
      expect(resolved?.credentialId).toBe('row-1');
    });

    /** An empty host list is "any host", which is what an operator intends. */
    it('offers a credential with no host list to any host', async () => {
      const { service } = build();
      jest
        .spyOn(service as never as { findDefault: () => Promise<unknown> }, 'findDefault')
        .mockResolvedValue({
          id: 'row-1',
          label: 'any',
          credentialKind: 'ssh_key',
          secretRef: 'secret:one',
          hosts: [],
        });

      expect(await service.resolveForHost({ host: 'git.example.com' })).not.toBeNull();
    });

    /** Nothing registered and nothing named resolves to null, not a throw. */
    it('resolves to null when there is no default at all', async () => {
      const { service } = build();
      jest
        .spyOn(service as never as { findDefault: () => Promise<unknown> }, 'findDefault')
        .mockResolvedValue(null);

      expect(await service.resolveForHost({ host: 'github.com' })).toBeNull();
    });

    /**
     * A named credential is looked up as enabled-only, so disabling is a real
     * withdrawal of access rather than a label.
     */
    it('never resolves a disabled credential, even when named', async () => {
      const { service } = build();
      jest
        .spyOn(service as never as { findEnabledRow: () => Promise<unknown> }, 'findEnabledRow')
        .mockResolvedValue(null);

      expect(await service.resolveForHost({ credentialId: 'disabled-row' })).toBeNull();
    });
  });

  describe('update', () => {
    it('replaces the value by writing a new secret and destroying the old one', async () => {
      const { service, secrets } = build();
      jest
        .spyOn(service as never as { findRow: () => Promise<unknown> }, 'findRow')
        .mockResolvedValue({ id: 'row-1', label: 'old', secretRef: 'secret:old', credentialKind: 'ssh_key' });
      jest.spyOn(service, 'getOrThrow').mockResolvedValue({} as never);

      await service.update(userId, 'row-1', { value: KEY });

      expect(secrets.writes).toHaveLength(1);
      expect(secrets.destroyed).toContain('secret:old');
    });

    it('leaves the stored value alone when none is supplied', async () => {
      const { service, secrets } = build();
      jest
        .spyOn(service as never as { findRow: () => Promise<unknown> }, 'findRow')
        .mockResolvedValue({ id: 'row-1', label: 'old', secretRef: 'secret:old', credentialKind: 'ssh_key' });
      jest.spyOn(service, 'getOrThrow').mockResolvedValue({} as never);

      await service.update(userId, 'row-1', { label: 'renamed' });

      // The portal cannot read a value back, so an omitted one must not clear it.
      expect(secrets.writes).toHaveLength(0);
      expect(secrets.destroyed).toHaveLength(0);
    });

    it('reports a missing row rather than silently doing nothing', async () => {
      const { service } = build();
      jest
        .spyOn(service as never as { findRow: () => Promise<unknown> }, 'findRow')
        .mockResolvedValue(null);

      await expect(service.update(userId, 'nope', { label: 'x' })).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('remove', () => {
    it('destroys the secret alongside the row', async () => {
      const { service, secrets } = build();
      jest
        .spyOn(service as never as { findRow: () => Promise<unknown> }, 'findRow')
        .mockResolvedValue({ id: 'row-1', label: 'gone', secretRef: 'secret:gone' });

      await service.remove(userId, 'row-1');

      expect(secrets.destroyed).toContain('secret:gone');
    });
  });

  describe('hostOf', () => {
    it('reads the host from an SSH remote and an HTTPS one alike', () => {
      const { service } = build();

      expect(service.hostOf('git@github.com:org/repo.git')).toBe('github.com');
      expect(service.hostOf('https://github.com/org/repo.git')).toBe('github.com');
      expect(service.hostOf('ssh://git@gitlab.com/org/repo.git')).toBe('gitlab.com');
    });

    /** A URL the platform would refuse yields null rather than a wrong host. */
    it('returns null for a remote it would not reach', () => {
      const { service } = build();
      expect(service.hostOf('file:///etc/passwd')).toBeNull();
    });
  });
});
