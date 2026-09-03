import { BadRequestException } from '@nestjs/common';
import { ModelSettingsService } from './model-settings.service';
import type { DatabaseService } from '../../core/database/database.service';
import type { AuditService } from '../../core/audit/audit.service';
import type { SecretsProvider } from '../../core/secrets/secrets.provider';
import type { AppConfig } from '../../core/config/configuration';

/**
 * The organisation's model provider configuration (ADR-023).
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
    const write = (input: Parameters<ModelSettingsService['write']>[2]) =>
      service.write('org-1', 'user-1', input);

    it('refuses a provider that is not offered', async () => {
      await expect(write({ providerId: 'gemini' as never })).rejects.toThrow(BadRequestException);
    });

    it('refuses openai-compatible with no base URL', async () => {
      await expect(
        write({ providerId: 'openai-compatible', apiKey: 'sk-test-key' }),
      ).rejects.toThrow(/needs a base URL/);
    });

    it('refuses a base URL that is not a URL', async () => {
      await expect(
        write({ providerId: 'openai-compatible', apiKey: 'sk-x', baseUrl: 'api.example.com' }),
      ).rejects.toThrow(/not a valid URL/);
    });

    it('refuses a plaintext endpoint, because the prompt carries source code', async () => {
      await expect(
        write({
          providerId: 'openai-compatible',
          apiKey: 'sk-x',
          baseUrl: 'http://api.example.com/v1',
        }),
      ).rejects.toThrow(/must use https/);
    });

    it('refuses an over-long model name', async () => {
      await expect(
        write({ providerId: 'anthropic', apiKey: 'sk-x', model: 'm'.repeat(201) }),
      ).rejects.toThrow(/longer than 200/);
    });

    it('refuses an over-long key rather than sealing it', async () => {
      await expect(
        write({ providerId: 'anthropic', apiKey: 'k'.repeat(8193) }),
      ).rejects.toThrow(/longer than 8192/);
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
  });
});
