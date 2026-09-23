import { FailoverModelProvider } from './failover-model-provider';
import { ModelProviderError, type ModelProvider, type ToolLoopOutcome } from './model-provider.interface';

/**
 * The bug this guards: an upstream answered HTTP 200 with an empty closing
 * message (task_355199 - all three tool calls succeeded, the final response
 * was blank). Nothing threw, so the chain never moved on and the task
 * completed with an empty answer.
 *
 * The fix has two halves and both are asserted here, because either one alone
 * is not enough: `AiSdkModelProvider` has to notice the empty close and throw a
 * *retryable* `ModelProviderError` (asserted in `empty-and-denied-outcome.spec.ts`
 * against the source, since building a provider needs a live model), and this
 * chain has to actually read that flag. A provider that raised a retryable
 * error correctly could still stop the chain here if `movesOn` never looked at
 * it - which is the regression this spec would have caught: the guard fired,
 * `retryable: true` was set, and the chain re-threw immediately anyway.
 */
function fakeProvider(id: string, result: () => Promise<ToolLoopOutcome>): ModelProvider {
  return {
    id,
    model: id,
    callsExternalService: true,
    generateStructured: async () => {
      throw new Error(`${id}: generateStructured not used by this test`);
    },
    runToolLoop: async () => ({
      value: await result(),
      usage: { inputTokens: 1, outputTokens: 1, durationMs: 1 },
      boundaryFindings: [],
      redactionCount: 0,
      steps: 1,
    }),
  };
}

describe('the failover chain, on a provider that answered nothing', () => {
  it('moves on to the next member when the failure is marked retryable', async () => {
    const empty = fakeProvider('empty-upstream', async () => {
      throw new ModelProviderError(
        'openai-compatible',
        'The model returned an empty response with no tool calls and no halt reason.',
        true,
        undefined,
        false,
        'empty-upstream',
      );
    });

    const answers = fakeProvider('answering-upstream', async () => ({
      summary: 'Isi al3_sale_mod: models, __manifest__.py.',
      toolCalls: 1,
    }));

    const chain = new FailoverModelProvider([
      { priority: 1, label: 'primary', provider: empty },
      { priority: 2, label: 'secondary', provider: answers },
    ]);

    const result = await chain.runToolLoop({
      system: 's',
      parts: [],
      tools: [],
      execute: async () => ({ result: {} }),
      maxSteps: 1,
      maxToolCalls: 1,
    });

    expect(result.value.summary).toBe('Isi al3_sale_mod: models, __manifest__.py.');
  });

  it('does NOT move on when the same failure is not marked retryable', async () => {
    const empty = fakeProvider('empty-upstream', async () => {
      throw new ModelProviderError(
        'openai-compatible',
        'The model returned an empty response.',
        false,
        undefined,
        false,
        'empty-upstream',
      );
    });

    const answers = fakeProvider('answering-upstream', async () => ({
      summary: 'should not be reached',
      toolCalls: 1,
    }));

    const chain = new FailoverModelProvider([
      { priority: 1, label: 'primary', provider: empty },
      { priority: 2, label: 'secondary', provider: answers },
    ]);

    await expect(
      chain.runToolLoop({
        system: 's',
        parts: [],
        tools: [],
        execute: async () => ({ result: {} }),
        maxSteps: 1,
        maxToolCalls: 1,
      }),
    ).rejects.toThrow('The model returned an empty response.');
  });
});
