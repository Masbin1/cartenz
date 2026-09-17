import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A refused tool call must tell the model WHY it was refused.
 *
 * This exists because of a real defect. `edit_file` was called without its
 * required `summary` argument; the permission validator refused it with
 * "invalid request for edit_file: summary is required and must be a string",
 * and that reason was recorded in the audit trail and then discarded. What
 * reached the model was the fixed sentence "The platform refused this call. Do
 * not retry it or work around it."
 *
 * So the model could not tell a correctable mistake from a forbidden
 * capability. It retried with a different `find` span - the one thing that was
 * not wrong - was refused identically, gave up after two attempts and reported
 * that the platform was blocking it. The task failed as "made no change to the
 * working tree" with a clean working tree, and the agent's own summary asked a
 * reviewer to unblock a tool that had never been blocked.
 *
 * The reason travelled as far as `ToolExecutionResult.denialReason` and was
 * dropped at three separate points on the way to the model, which is why the
 * whole chain is asserted here rather than one function.
 */
describe('a denial carries its reason back to the model', () => {
  const read = (name: string): string => readFileSync(join(__dirname, name), 'utf8');

  describe('the implementation loop', () => {
    const source = read('model-implementation-loop.ts');

    it('puts the denial reason in the message the model sees', () => {
      expect(source).toMatch(/The platform refused this call: \$\{outcome\.denialReason\}/);
    });

    it('still refuses usefully when no reason was given', () => {
      expect(source).toContain(
        'The platform refused this call. Do not retry it or work around it.',
      );
    });

    it('declares denialReason on its runner, or the workflow cannot pass one', () => {
      expect(source).toMatch(/LoopToolRunner[\s\S]*?denialReason\?: string/);
    });
  });

  describe('the chat loop', () => {
    const source = read('model-chat-loop.ts');

    it('puts the denial reason in the message the model sees', () => {
      expect(source).toMatch(/The platform refused this call: \$\{outcome\.denialReason\}/);
    });

    it('declares denialReason on its runner', () => {
      expect(source).toMatch(/ChatLoopToolRunner[\s\S]*?denialReason\?: string/);
    });
  });

  describe('the workflow, which is where the reason was dropped', () => {
    const source = read('agent-workflow.ts');

    it('returns denialReason from callTool', () => {
      // Both the declared return type and the value: the type alone compiled
      // happily while the property was never set.
      expect(source).toMatch(
        /status: 'succeeded' \| 'failed' \| 'denied' \| 'suspended';[\s\S]*?denialReason\?: string/,
      );
      expect(source).toMatch(/output: result\.output \?\? \{\},\s*\n\s*denialReason: result\.denialReason,/);
    });

    it('forwards it at every runner call site', () => {
      const runners = [...source.matchAll(/run: async \(call\) => \{([\s\S]*?)\n {8}\},/g)].map(
        ([, body]) => body,
      );

      expect(runners.length).toBeGreaterThanOrEqual(3);

      const dropping = runners.filter((body) => !/denialReason: \w+\.denialReason/.test(body));
      expect(dropping).toEqual([]);
    });
  });
});
