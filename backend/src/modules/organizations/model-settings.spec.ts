import { BadRequestException } from '@nestjs/common';
import { ModelSettingsService, assertHttpsUrl } from './model-settings.service';
import type { DatabaseService } from '../../core/database/database.service';
import type { AuditService } from '../../core/audit/audit.service';
import type { SecretsProvider } from '../../core/secrets/secrets.provider';
import type { AppConfig } from '../../core/config/configuration';

/**
 * The organisation's model provider configuration (ADR-023, extended to a list).
 *
 * The validation tests use no database: `assertValid` is reached before any
 * query, and keeping it that way is what makes the refusals easy to be certain
 * of. The tests that need storage use a small in-memory stand-in rather than a
 * real Postgres, because what is being asserted is the handling of the key, not
 * the SQL.
 */
describe('ModelSettingsService', () => {
  const config = {
    ai: { provider: 'mock', model: 'mock-agent-v1', baseUrl: undefined, apiKey: undefined },
  } as unknown as AppConfig;

  const noAudit = { record: async () => undefined } as unknown as AuditService;

  const build = (secrets?: Partial<SecretsProvider>) =>
    new ModelSettingsService(
      {} as DatabaseService,
      noAudit,
      {
        write: async () => ({ ref: 'secret:model-api-key:0001' }),
        read: async () => 'unsealed',
        destroy: async () => undefined,
        exists: async () => true,
        ...secrets,
      } as SecretsProvider,
      config,
    );

  describe('validation, before anything is stored', () => {
    const service = build();

    // Reaching the database would mean the refusal came too late to be certain
    // nothing was written, so these assert the message rather than mock storage.
    const add = (input: Parameters<ModelSettingsService['addRow']>[2]) =>
      service.addRow('org-1', 'user-1', input);

    it('refuses a provider that is not offered', async () => {
      await expect(add({ providerId: 'gemini' as never })).rejects.toThrow(BadRequestException);
    });

    it('refuses openai-compatible with no base URL', async () => {
      await expect(
        add({ providerId: 'openai-compatible', apiKey: 'sk-test-key' }),
      ).rejects.toThrow(/needs a base URL/);
    });

    it('refuses a base URL that is not a URL', async () => {
      await expect(
        add({ providerId: 'openai-compatible', apiKey: 'sk-x', baseUrl: 'api.example.com' }),
      ).rejects.toThrow(/not a valid URL/);
    });

    it('refuses a plaintext endpoint, because the prompt carries source code', async () => {
      await expect(
        add({
          providerId: 'openai-compatible',
          apiKey: 'sk-x',
          baseUrl: 'http://api.example.com/v1',
        }),
      ).rejects.toThrow(/must use https/);
    });

    it('refuses an over-long model name', async () => {
      await expect(
        add({ providerId: 'anthropic', apiKey: 'sk-x', model: 'm'.repeat(201) }),
      ).rejects.toThrow(/longer than 200/);
    });

    it('refuses an over-long key rather than sealing it', async () => {
      await expect(
        add({ providerId: 'anthropic', apiKey: 'k'.repeat(8193) }),
      ).rejects.toThrow(/longer than 8192/);
    });

    it('refuses a label longer than the column', async () => {
      await expect(
        add({ providerId: 'anthropic', apiKey: 'sk-x', label: 'L'.repeat(121) }),
      ).rejects.toThrow(/longer than 120/);
    });
  });

  /**
   * Amendment A: `discoverModels` fetches a caller-supplied URL from the server,
   * so it must apply the same transport rule the save path does. `assertHttpsUrl`
   * is that rule; these tests assert it directly rather than through a network
   * call, since the point is the refusal happening before any fetch.
   */
  describe('assertHttpsUrl, shared by the save path and discoverModels', () => {
    it('refuses a plaintext endpoint that is not on this machine', () => {
      expect(() => assertHttpsUrl('http://api.example.com/v1')).toThrow(/must use https/);
    });

    it('accepts plain http for loopback', () => {
      expect(() => assertHttpsUrl('http://127.0.0.1:20128/v1')).not.toThrow();
    });
  });

  describe('the chain the resolver is handed', () => {
    /**
     * Rows in the order Postgres happens to return them, which is not priority
     * order. The failover chain iterates the array it is given, so what this
     * asserts is that the ordering is done here rather than assumed downstream.
     */
    const rows = [
      { id: 'r2', organizationId: 'org-1', priority: 2, label: 'fallback', enabled: true,
        providerId: 'anthropic', model: null, baseUrl: null, structuredOutputs: null,
        secretRef: 'secret:b', revision: 1 },
      { id: 'r3', organizationId: 'org-1', priority: 3, label: 'disabled one', enabled: false,
        providerId: 'anthropic', model: null, baseUrl: null, structuredOutputs: null,
        secretRef: 'secret:c', revision: 1 },
      { id: 'r1', organizationId: 'org-1', priority: 1, label: 'primary', enabled: true,
        providerId: 'openai-compatible', model: 'deepseek-chat',
        baseUrl: 'https://api.deepseek.com', structuredOutputs: false,
        secretRef: 'secret:a', revision: 1 },
    ];

    const withRows = (returned: typeof rows) =>
      new ModelSettingsService(
        {
          db: {
            select: () => ({
              from: () => ({
                where: () => ({
                  // Sorted here because this stands in for the SQL ORDER BY;
                  // the assertion below is that the service asks for it at all.
                  orderBy: async () => [...returned].sort((a, b) => a.priority - b.priority),
                }),
              }),
            }),
          },
        } as unknown as DatabaseService,
        noAudit,
        { write: async () => ({ ref: 'r' }), read: async () => 'unsealed',
          destroy: async () => undefined, exists: async () => true } as SecretsProvider,
        config,
      );

    it('hands the members over in priority order', async () => {
      const chain = await withRows(rows).resolveChain('org-1');
      expect(chain.members.map((member) => member.label)).toEqual(['primary', 'fallback']);
    });

    it('leaves a disabled row out rather than filtering it downstream', async () => {
      const chain = await withRows(rows).resolveChain('org-1');
      expect(chain.members.map((member) => member.id)).not.toContain('r3');
      // The revision sums only what will actually be called, so disabling a row
      // changes it and the cached chain is rebuilt.
      expect(chain.revision).toBe(2);
    });
  });

  describe('a loopback row saved with no key', () => {
    /**
     * Accepted, not refused: ollama and llama.cpp genuinely have no key to give.
     * But 9router and Hermes authenticate, and the failure they produce arrives a
     * task later, far from the person who saved the row.
     */
    it('warns rather than refusing, because ollama has no key to give', () => {
      const service = build();
      const warn = (service as unknown as {
        keylessLoopbackWarning(baseUrl: string | null, hasKey: boolean): string | null;
      }).keylessLoopbackWarning.bind(service);

      const warning = warn('http://127.0.0.1:20128/v1', false);

      expect(warning).toContain('9router');
      expect(warning).toContain('ollama');
    });

    it('says nothing when a key is stored', () => {
      const service = build();
      const warn = (service as unknown as {
        keylessLoopbackWarning(baseUrl: string | null, hasKey: boolean): string | null;
      }).keylessLoopbackWarning.bind(service);

      expect(warn('http://127.0.0.1:20128/v1', true)).toBeNull();
    });

    it('says nothing for an endpoint that is not on this machine', () => {
      const service = build();
      const warn = (service as unknown as {
        keylessLoopbackWarning(baseUrl: string | null, hasKey: boolean): string | null;
      }).keylessLoopbackWarning.bind(service);

      // A third-party endpoint with no key is refused outright elsewhere, so a
      // warning here would be a second, weaker answer to a settled question.
      expect(warn('https://api.deepseek.com', false)).toBeNull();
    });

    /**
     * Drives list() rather than the warning method, because the value the
     * warning is asked about must be the same one the screen is shown. Two
     * expressions computing it would eventually disagree, and the direction they
     * would disagree in is telling someone a token is stored when none is.
     */
    it('reports both the absent key and the warning, from one answer', async () => {
      const row = {
        id: 'row-1',
        organizationId: 'org-1',
        priority: 1,
        label: null,
        enabled: true,
        providerId: 'openai-compatible',
        model: 'Paket-Hemat',
        baseUrl: 'http://127.0.0.1:20128/v1',
        structuredOutputs: null,
        secretRef: null,
        revision: 3,
        updatedAt: new Date('2026-09-04T00:00:00.000Z'),
      };

      const service = new ModelSettingsService(
        {
          db: {
            select: () => ({
              from: () => ({
                where: () => ({
                  orderBy: async () => [row],
                }),
              }),
            }),
          },
        } as unknown as DatabaseService,
        noAudit,
        {
          write: async () => ({ ref: 'secret:model-api-key:0001' }),
          read: async () => 'unsealed',
          destroy: async () => undefined,
          exists: async () => true,
        } as SecretsProvider,
        config,
      );

      const list = await service.list('org-1');

      expect(list.fromEnvironment).toBe(false);
      expect(list.rows[0].hasApiKey).toBe(false);
      expect(list.rows[0].warning).toContain('9router');
    });

    it('says nothing once a key is stored against the same row', async () => {
      const row = {
        id: 'row-1',
        organizationId: 'org-1',
        priority: 1,
        label: null,
        enabled: true,
        providerId: 'openai-compatible',
        model: 'Paket-Hemat',
        baseUrl: 'http://127.0.0.1:20128/v1',
        structuredOutputs: null,
        secretRef: 'secret:model-api-key:0001',
        revision: 4,
        updatedAt: new Date('2026-09-04T00:00:00.000Z'),
      };

      const service = new ModelSettingsService(
        {
          db: {
            select: () => ({
              from: () => ({
                where: () => ({
                  orderBy: async () => [row],
                }),
              }),
            }),
          },
        } as unknown as DatabaseService,
        noAudit,
        {
          write: async () => ({ ref: 'secret:model-api-key:0001' }),
          read: async () => 'unsealed',
          destroy: async () => undefined,
          exists: async () => true,
        } as SecretsProvider,
        config,
      );

      const list = await service.list('org-1');

      expect(list.rows[0].hasApiKey).toBe(true);
      expect(list.rows[0].warning).toBeNull();
    });
  });
});
