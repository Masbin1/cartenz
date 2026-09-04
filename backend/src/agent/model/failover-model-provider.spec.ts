import { z } from 'zod';
import { FailoverModelProvider } from './failover-model-provider';
import { ModelProviderError, type ModelProvider } from './model-provider.interface';
import { AiBoundaryRefusalError } from '../../core/ai-boundary/boundary-types';

/**
 * The chain that keeps a task alive when one endpoint will not serve it
 * (ADR-023 extended).
 *
 * The distinction under test is which failures mean "this provider cannot do it"
 * and which mean "nobody can". Moving on from the second wastes a task's budget
 * to arrive at the same answer, and moving on from a boundary refusal would turn
 * a security decision into a retry loop.
 */
describe('FailoverModelProvider', () => {
  const schema = z.object({ status: z.string() });

  const request = {
    system: 'system',
    parts: [{ label: 'Check', content: 'go' }],
    schema,
    schemaName: 'Check',
  };

  /** A provider that answers, or fails with exactly what it is given. */
  const stub = (id: string, failure?: unknown): ModelProvider => ({
    id,
    model: `${id}-model`,
    callsExternalService: true,
    generateStructured: async () => {
      if (failure) throw failure;
      return {
        value: { status: 'OK' } as never,
        usage: { inputTokens: 1, outputTokens: 1, durationMs: 1 },
        boundaryFindings: [],
        redactionCount: 0,
        steps: 1,
      };
    },
    runToolLoop: async () => {
      if (failure) throw failure;
      return {
        value: { summary: 'done', toolCalls: 0 },
        usage: { inputTokens: 1, outputTokens: 1, durationMs: 1 },
        boundaryFindings: [],
        redactionCount: 0,
        steps: 1,
      };
    },
  });

  const chain = (...members: { provider: ModelProvider; label?: string }[]) =>
    new FailoverModelProvider(
      members.map((entry, index) => ({
        priority: index + 1,
        label: entry.label ?? `member-${index + 1}`,
        provider: entry.provider,
      })),
    );

  // Constructed the way AiSdkModelProvider constructs it, status included, so
  // these exercise the real contract rather than a stand-in with a field bolted
  // on. That distinction is the whole defect: the status used to be dropped here.
  const httpError = (status: number) =>
    new ModelProviderError('openai-compatible', `HTTP ${status}`, status >= 500, status);

  describe('moving on', () => {
    // 429 is the case the feature exists for: one account's quota is spent and
    // another account's is not.
    it.each([401, 402, 403, 404, 429, 500, 503])(
      'tries the next provider after HTTP %i',
      async (status) => {
        const second = stub('second');
        const provider = chain({ provider: stub('first', httpError(status)) }, { provider: second });

        const result = await provider.generateStructured(request);

        expect(result.value).toEqual({ status: 'OK' });
      },
    );

    it('skips straight past a provider that timed out', async () => {
      const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
      const provider = chain({ provider: stub('first', timeout) }, { provider: stub('second') });

      await expect(provider.generateStructured(request)).resolves.toMatchObject({
        value: { status: 'OK' },
      });
    });

    it('fails over in the tool loop too, not only in structured generation', async () => {
      const provider = chain(
        { provider: stub('first', httpError(429)) },
        { provider: stub('second') },
      );

      const result = await provider.runToolLoop({
        system: 'system',
        parts: [],
        tools: [],
        execute: async () => ({ result: {} }),
        maxSteps: 1,
        maxToolCalls: 1,
      });

      expect(result.value.summary).toBe('done');
    });
  });

  describe('stopping', () => {
    // A malformed request is malformed everywhere. Trying it against three
    // endpoints spends three times as much to be told the same thing.
    it('stops on HTTP 400 rather than asking everyone else', async () => {
      const second = stub('second');
      const spy = jest.spyOn(second, 'generateStructured');
      const provider = chain({ provider: stub('first', httpError(400)) }, { provider: second });

      await expect(provider.generateStructured(request)).rejects.toThrow(ModelProviderError);
      expect(spy).not.toHaveBeenCalled();
    });

    /**
     * The rule that matters most. A refusal means the material must not be sent
     * to a provider — any provider. Failing over would ask a second endpoint for
     * exactly what the first was forbidden.
     */
    it('rethrows a boundary refusal untouched and calls nobody else', async () => {
      const refusal = new AiBoundaryRefusalError('Check', 'a credential was found', []);
      const second = stub('second');
      const spy = jest.spyOn(second, 'generateStructured');
      const provider = chain({ provider: stub('first', refusal) }, { provider: second });

      await expect(provider.generateStructured(request)).rejects.toBe(refusal);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('when every provider fails', () => {
    /**
     * The first priority's error, not the last. The last is usually the least
     * informative, and the question being asked is why the primary failed.
     */
    it('reports the first priority failure and summarises the rest', async () => {
      const provider = chain(
        { provider: stub('first', httpError(401)), label: 'nine-router' },
        { provider: stub('second', httpError(429)), label: 'deepseek' },
      );

      let message = '';
      try {
        await provider.generateStructured(request);
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).toContain('HTTP 401');
      expect(message).toContain('nine-router');
      expect(message).toContain('deepseek');
    });
  });

  describe('the list itself', () => {
    it('reports the first member as its identity, which is what it usually is', () => {
      const provider = chain({ provider: stub('first') }, { provider: stub('second') });

      expect(provider.id).toBe('first');
      expect(provider.model).toBe('first-model');
    });

    it('refuses to be built empty, because there is nothing to call', () => {
      expect(() => new FailoverModelProvider([])).toThrow(/at least one/);
    });
  });
});
