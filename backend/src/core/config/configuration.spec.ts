import { ConfigurationError, loadConfig } from './configuration';

/**
 * Configuration validation is what turns a misconfigured deployment into a
 * failed boot rather than a failed request, so these tests assert that the
 * required values really are required.
 */
describe('loadConfig', () => {
  const valid = {
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/linkederp_ai',
    REDIS_URL: 'redis://localhost:6379/0',
    JWT_SECRET: 'a'.repeat(32),
    SECRETS_ROOT_KEY: 'f'.repeat(64),
  };

  it('accepts a minimal valid environment and applies the documented defaults', () => {
    const config = loadConfig(valid);

    expect(config.env).toBe('development');
    expect(config.api.port).toBe(4000);
    expect(config.api.corsOrigins).toEqual(['http://localhost:3000']);
    expect(config.auth.accessTtl).toBe('15m');
    expect(config.auth.refreshTtl).toBe('30d');
    expect(config.ai.provider).toBe('mock');
    expect(config.secrets.provider).toBe('envelope');
    expect(config.secrets.rootKey).toHaveLength(32);
  });

  it('disables on-premise execution by default, and enables it with a root path', () => {
    expect(loadConfig(valid).onPremise.root).toBeNull();
    expect(loadConfig(valid).onPremise.readOnlyPaths).toEqual([]);

    const config = loadConfig({ ...valid, ON_PREMISE_ROOT: '/home/masbintang/linkederp' });
    expect(config.onPremise.root).toBe('/home/masbintang/linkederp');
  });

  it('parses read-only on-premise paths', () => {
    const config = loadConfig({
      ...valid,
      ON_PREMISE_READ_ONLY_PATHS: '/home/masbintang/linkederp/odoo, /home/masbintang/linkederp/enterprise',
    });
    expect(config.onPremise.readOnlyPaths).toEqual([
      '/home/masbintang/linkederp/odoo',
      '/home/masbintang/linkederp/enterprise',
    ]);
  });

  it('refuses a non-absolute on-premise root or read-only path', () => {
    expect(() => loadConfig({ ...valid, ON_PREMISE_ROOT: 'relative/path' })).toThrow(
      ConfigurationError,
    );
    expect(() =>
      loadConfig({ ...valid, ON_PREMISE_READ_ONLY_PATHS: '/abs/odoo,relative/enterprise' }),
    ).toThrow(ConfigurationError);
  });

  it('refuses to start without a database URL', () => {
    const { DATABASE_URL: _omitted, ...withoutDatabase } = valid;
    expect(() => loadConfig(withoutDatabase)).toThrow(ConfigurationError);
  });

  it('refuses to start without a JWT secret, and rejects a short one', () => {
    const { JWT_SECRET: _omitted, ...withoutSecret } = valid;
    expect(() => loadConfig(withoutSecret)).toThrow(ConfigurationError);
    expect(() => loadConfig({ ...valid, JWT_SECRET: 'too-short' })).toThrow(ConfigurationError);
  });

  it('requires the secrets root key to be 32 bytes of hex', () => {
    const { SECRETS_ROOT_KEY: _omitted, ...withoutKey } = valid;
    expect(() => loadConfig(withoutKey)).toThrow(ConfigurationError);
    expect(() => loadConfig({ ...valid, SECRETS_ROOT_KEY: 'f'.repeat(63) })).toThrow(
      ConfigurationError,
    );
    expect(() => loadConfig({ ...valid, SECRETS_ROOT_KEY: 'z'.repeat(64) })).toThrow(
      ConfigurationError,
    );
  });

  it('rejects a connection string for the wrong scheme', () => {
    expect(() => loadConfig({ ...valid, DATABASE_URL: 'mysql://localhost/db' })).toThrow(
      ConfigurationError,
    );
    expect(() => loadConfig({ ...valid, REDIS_URL: 'http://localhost:6379' })).toThrow(
      ConfigurationError,
    );
  });

  it('reports every problem at once', () => {
    try {
      loadConfig({ JWT_SECRET: 'short' });
      fail('the configuration should have been refused');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('REDIS_URL');
      expect(message).toContain('SECRETS_ROOT_KEY');
      expect(message).toContain('JWT_SECRET');
    }
  });

  it('refuses the development providers in production', () => {
    expect(() =>
      loadConfig({
        ...valid,
        NODE_ENV: 'production',
        AI_PROVIDER: 'anthropic',
        AI_API_KEY: 'sk-ant-test',
      }),
    ).toThrow(/SECRETS_PROVIDER=envelope/);

    expect(() =>
      loadConfig({ ...valid, NODE_ENV: 'production', SECRETS_PROVIDER: 'vault' }),
    ).toThrow(/AI_PROVIDER=mock/);
  });

  it('accepts a production environment configured with real providers', () => {
    const config = loadConfig({
      ...valid,
      NODE_ENV: 'production',
      SECRETS_PROVIDER: 'vault',
      AI_PROVIDER: 'anthropic',
      AI_API_KEY: 'sk-ant-test',
      CORS_ORIGINS: 'https://portal.example.com,https://admin.example.com',
    });

    expect(config.isProduction).toBe(true);
    expect(config.api.corsOrigins).toEqual([
      'https://portal.example.com',
      'https://admin.example.com',
    ]);
  });

  describe('AI provider configuration', () => {
    it('refuses a named provider with no key, at boot', () => {
      // The operator who sets AI_PROVIDER is not the person who submits the task,
      // so this must fail at boot rather than at the first request.
      expect(() => loadConfig({ ...valid, AI_PROVIDER: 'anthropic' })).toThrow(
        /AI_API_KEY is not set/,
      );
    });

    it('refuses an OpenAI-compatible provider with no base URL', () => {
      expect(() =>
        loadConfig({
          ...valid,
          AI_PROVIDER: 'openai-compatible',
          AI_API_KEY: 'key',
        }),
      ).toThrow(/AI_BASE_URL is not set/);
    });

    it('accepts a self-hosted OpenAI-compatible endpoint', () => {
      const config = loadConfig({
        ...valid,
        AI_PROVIDER: 'openai-compatible',
        AI_API_KEY: 'key',
        AI_BASE_URL: 'https://models.internal/v1',
      });

      expect(config.ai.provider).toBe('openai-compatible');
      expect(config.ai.baseUrl).toBe('https://models.internal/v1');
    });

    it('needs no key for the scripted provider', () => {
      expect(loadConfig(valid).ai.provider).toBe('mock');
    });

    it('applies the documented model call bounds', () => {
      const config = loadConfig(valid);

      expect(config.ai.maxSteps).toBe(12);
      expect(config.ai.maxToolCalls).toBe(30);
      expect(config.ai.maxOutputTokens).toBe(8000);
      expect(config.ai.requestTimeoutMs).toBe(120000);
      // Zero, because a code change wants the most deterministic output.
      expect(config.ai.temperature).toBe(0);
    });

    it('enforces JSON schema by default, and disables it for DeepSeek-style endpoints', () => {
      // Default: the endpoint enforces the plan's schema itself.
      expect(loadConfig(valid).ai.structuredOutputs).toBe(true);

      const config = loadConfig({ ...valid, AI_STRUCTURED_OUTPUTS: 'false' });
      expect(config.ai.structuredOutputs).toBe(false);
    });

    it('rejects bounds outside their permitted range', () => {
      expect(() => loadConfig({ ...valid, AI_MAX_STEPS: '0' })).toThrow();
      expect(() => loadConfig({ ...valid, AI_MAX_STEPS: '5000' })).toThrow();
      expect(() => loadConfig({ ...valid, AI_TEMPERATURE: '5' })).toThrow();
    });
  });

  it('treats an empty optional value as absent', () => {
    const config = loadConfig({ ...valid, AI_BASE_URL: '', AI_API_KEY: '' });
    expect(config.ai.baseUrl).toBeUndefined();
    expect(config.ai.apiKey).toBeUndefined();
  });

  it('rejects a malformed duration', () => {
    expect(() => loadConfig({ ...valid, JWT_ACCESS_TTL: 'fifteen minutes' })).toThrow(
      ConfigurationError,
    );
  });

  /**
   * A gateway configured through the environment (ADR-023).
   *
   * This is the shape a consultancy server uses: one router holding the vendor
   * keys, one endpoint, and no organisation pasting anything into the portal. The
   * portal has always refused a plaintext endpoint that is not on this machine;
   * the environment path did not, which meant the operator path - where a mistake
   * is quietest - was the one without the check.
   */
  describe('an OpenAI-compatible gateway from the environment', () => {
    const gateway = (baseUrl: string) => ({
      ...valid,
      AI_PROVIDER: 'openai-compatible',
      AI_BASE_URL: baseUrl,
      AI_API_KEY: 'k',
      AI_MODEL: 'Paket-Hemat',
    });

    it('accepts a gateway on this machine over plain http', () => {
      // A router on loopback has no network to intercept.
      expect(() => loadConfig(gateway('http://127.0.0.1:20128/v1'))).not.toThrow();
      expect(() => loadConfig(gateway('http://localhost:11434/v1'))).not.toThrow();
    });

    it('refuses a plaintext endpoint that is not on this machine', () => {
      expect(() => loadConfig(gateway('http://10.0.0.5:20128/v1'))).toThrow(/plain http/);
    });

    it('accepts a remote gateway over https', () => {
      expect(() => loadConfig(gateway('https://router.example.com/v1'))).not.toThrow();
    });

    it('still refuses an openai-compatible provider with no base URL', () => {
      const { AI_BASE_URL: _omitted, ...withoutUrl } = gateway('http://127.0.0.1:20128/v1');
      expect(() => loadConfig(withoutUrl)).toThrow(/AI_BASE_URL/);
    });

    it('still refuses a real provider with no key', () => {
      const { AI_API_KEY: _omitted, ...withoutKey } = gateway('http://127.0.0.1:20128/v1');
      expect(() => loadConfig(withoutKey)).toThrow(/AI_API_KEY/);
    });
  });
});
