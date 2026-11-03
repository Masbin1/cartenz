import { TaskKindClassifier } from './task-kind-classifier';
import type { ModelProviderResolver } from '../model/model-provider-resolver';
import type { ModelProvider } from '../model/model-provider.interface';

/**
 * ADR-088: the Odoo Online task-kind classifier.
 *
 * The one property worth pinning is the fail-safe direction: anything that
 * goes wrong - a bad value, a thrown error - must resolve to `change`, never
 * `chat`, because `change` is the one that still asks for approval before it
 * acts. A classifier that failed open toward `chat` would be a silent,
 * unreviewed write path the moment a provider call glitches.
 */
describe('TaskKindClassifier', () => {
  const resolverReturning = (provider: Partial<ModelProvider>) =>
    ({
      forProject: async () => provider as ModelProvider,
    }) as unknown as ModelProviderResolver;

  it('returns the kind the provider classifies', async () => {
    const classifier = new TaskKindClassifier(
      resolverReturning({
        generateStructured: (async () => ({
          value: { kind: 'chat' },
          usage: { inputTokens: 1, outputTokens: 1, durationMs: 1 },
          boundaryFindings: [],
          redactionCount: 0,
          steps: 1,
        })) as ModelProvider['generateStructured'],
      }),
    );

    expect(await classifier.classify('What fields exist on res.partner?', 'p1')).toBe('chat');
  });

  it('requests a fast-tier provider, not the main chain', async () => {
    const seen: Array<{ projectId?: string; options?: Record<string, unknown> }> = [];
    const resolver = {
      forProject: async (projectId?: string, options?: Record<string, unknown>) => {
        seen.push({ projectId, options });
        return {
          generateStructured: (async () => ({
            value: { kind: 'change' },
            usage: { inputTokens: 1, outputTokens: 1, durationMs: 1 },
            boundaryFindings: [],
            redactionCount: 0,
            steps: 1,
          })) as ModelProvider['generateStructured'],
        } as unknown as ModelProvider;
      },
    } as unknown as ModelProviderResolver;

    await new TaskKindClassifier(resolver).classify('Add a field', 'p1');

    expect(seen).toEqual([{ projectId: 'p1', options: { fast: true } }]);
  });

  it('defaults to change when the provider throws', async () => {
    const classifier = new TaskKindClassifier(
      resolverReturning({
        generateStructured: (async () => {
          throw new Error('no provider configured');
        }) as ModelProvider['generateStructured'],
      }),
    );

    expect(await classifier.classify('Add a field to Product', 'p1')).toBe('change');
  });

  it('defaults to change when resolving the provider itself throws', async () => {
    const resolver = {
      forProject: async () => {
        throw new Error('chain unavailable');
      },
    } as unknown as ModelProviderResolver;

    expect(await new TaskKindClassifier(resolver).classify('Add a field', 'p1')).toBe('change');
  });
});
