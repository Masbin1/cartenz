import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Two failures that both ended as "the task completed and nothing happened".
 *
 * They are asserted together because they share a cause: a value that is
 * *permitted* to be empty was treated as a value that succeeded.
 *
 * 1. An upstream answered HTTP 200 with an empty closing message. Nothing threw,
 *    nothing timed out, the schema was never involved, so the run was reported as
 *    a normal finish with `summary: ''`. The chat loop then had nothing to save
 *    and the task completed with an empty answer.
 *
 * 2. A write tool was refused because the model's own request was malformed - a
 *    missing `summary` argument. The refusal text told the model not to retry,
 *    which is right for a forbidden capability and wrong for a correctable
 *    mistake, so a fixable typo became "the platform is blocking me" and the task
 *    failed with a clean working tree.
 *
 * These are asserted against the source, as `denial-reason.spec.ts` does, because
 * both live inside a provider call and a tool-loop closure that no unit test here
 * constructs.
 */
describe('an empty or refused response is not a completed task', () => {
  const read = (relativePath: string): string =>
    readFileSync(join(__dirname, '..', relativePath), 'utf8');

  describe('the provider, on an empty closing message', () => {
    const source = read('model/ai-sdk-model-provider.ts');

    it('fails the call rather than returning an empty summary', () => {
      expect(source).toMatch(/finalStepWasEmpty/);
      expect(source).toMatch(/The model returned an empty response/);
    });

    it('treats it as retryable, so the failover chain moves on', () => {
      const block = source.slice(source.indexOf('finalStepWasEmpty'));
      expect(block).toMatch(/new ModelProviderError\([\s\S]*?true,/);
    });

    it('judges the final step, not the run, so a tool-calling step is not wrong', () => {
      expect(source).toMatch(/finalStep\?\.toolCalls\?\.length/);
    });

    it('exempts a halted run, which legitimately has nothing more to say', () => {
      expect(source).toMatch(/if \(!haltReason && finalStepWasEmpty\)/);
    });
  });

  describe('the implementation loop, on a correctable denial', () => {
    const source = read('orchestration/model-implementation-loop.ts');

    it('recognises a malformed-request denial from the validator wording', () => {
      expect(source).toMatch(
        /outcome\.denialReason\?\.startsWith\('invalid request for'\)/,
      );
    });

    it('tells the model to fix and repeat the call, not to give up', () => {
      expect(source).toMatch(/This is a request you can fix/);
      expect(source).toMatch(/call \$\{name\} again right now with that argument/);
    });

    it('keeps the plain refusal for a denial that is policy, not a mistake', () => {
      expect(source).toContain('The platform refused this call: ${outcome.denialReason}');
    });
  });

  describe('a chat task that wrote nothing and answered nothing', () => {
    const source = read('orchestration/agent-workflow.ts');

    it('fails the task instead of completing with a blank answer', () => {
      const block = source.slice(source.indexOf("private async implementChat"));
      expect(block).toMatch(/if \(answer\.length === 0\)/);
      expect(block).toMatch(/'implementing',\s*'failed'/);
      expect(block).toMatch(/produced no answer/);
    });

    it('still completes normally once an answer exists', () => {
      const block = source.slice(source.indexOf("private async implementChat"));
      expect(block).toMatch(/'implementing',\s*'testing'/);
    });
  });
});
