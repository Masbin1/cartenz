import { AiSdkModelProvider } from './ai-sdk-model-provider';
import { ModelProviderError } from './model-provider.interface';
import type { AppConfig } from '../../core/config/configuration';

/**
 * What a provider failure tells the person who has to fix it (ADR-023).
 *
 * These were written after a DeepSeek key was configured and the portal reported
 * "The AI provider rejected the request (AI_APICallError)" — true of a wrong key,
 * a wrong model name, an expired card and an unsupported feature alike, and so
 * useless for telling them apart.
 *
 * The provider's own error *message* is safe to quote and is quoted. The prompt
 * is not, and is not: it has been through the AI data boundary but is still the
 * customer's source code.
 */
describe('the model this platform sends when none is configured', () => {
  const config = { ai: { model: '', baseUrl: '', apiKey: '' } } as unknown as AppConfig;

  it('refuses to invent a model for an OpenAI-compatible endpoint', () => {
    // It used to send gpt-4o-mini to whatever endpoint was configured. A DeepSeek
    // gateway answering "Model Not Exist" reads exactly like a rejected key, which
    // is how an afternoon disappears.
    expect(
      () =>
        new AiSdkModelProvider(config, {
          provider: 'openai-compatible',
          baseUrl: 'https://api.deepseek.com',
          apiKey: 'k',
        }),
    ).toThrow(ModelProviderError);
  });

  it('names real models of real endpoints when it refuses', () => {
    let message = '';
    try {
      new AiSdkModelProvider(config, {
        provider: 'openai-compatible',
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'k',
      });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('deepseek-chat');
    expect(message).toContain('wire format');
  });

  it('still defaults for Anthropic, which names a vendor rather than a format', () => {
    const provider = new AiSdkModelProvider(config, {
      provider: 'anthropic',
      apiKey: 'k',
    });

    expect(provider.model).toBe('claude-sonnet-4-5');
  });

  it('uses the configured model when one is given', () => {
    const provider = new AiSdkModelProvider(config, {
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:20128/v1',
      model: 'Paket-Hemat',
      apiKey: 'k',
    });

    expect(provider.model).toBe('Paket-Hemat');
  });
});
