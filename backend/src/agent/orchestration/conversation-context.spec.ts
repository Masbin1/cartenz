import {
  buildConversationContext,
  CONVERSATION_CONTEXT_LABEL,
  DEFAULT_CONVERSATION_BUDGET,
  type ConversationTurn,
} from './conversation-context';

/**
 * ADR-074: per-conversation memory.
 *
 * `ChatLoopInput.conversationContext` existed since ADR-029 but nothing ever
 * filled it - a chat task only ever saw its own prompt, so "explain what you
 * said before in this conversation" was answered by a model with no earlier
 * turns to explain. These tests pin the part this module renders, which is what
 * `AgentWorkflow.implementChat` now passes into the chat loop.
 */
describe('buildConversationContext', () => {
  const turn = (overrides: Partial<ConversationTurn> = {}): ConversationTurn => ({
    reference: 'task_1',
    kind: 'chat',
    status: 'completed',
    prompt: 'What modules does this project have?',
    answer: 'The project has sale, stock and a custom linkederp_sales_modifier module.',
    failureReason: null,
    planSummary: null,
    modifiedPaths: [],
    ...overrides,
  });

  it('returns nothing for a task with no earlier turns', () => {
    expect(buildConversationContext([])).toEqual([]);
  });

  it('renders one part carrying every earlier prompt and answer', () => {
    const [part] = buildConversationContext([
      turn({ reference: 'task_1', prompt: 'Question one', answer: 'Answer one' }),
      turn({ reference: 'task_2', prompt: 'Question two', answer: 'Answer two' }),
    ]);

    expect(part.label).toBe(CONVERSATION_CONTEXT_LABEL);
    expect(part.untrusted).toBe(false);
    expect(part.content).toContain('Question one');
    expect(part.content).toContain('Answer one');
    expect(part.content).toContain('Question two');
    expect(part.content).toContain('Answer two');
  });

  it('keeps oldest-first order so the thread reads the way it happened', () => {
    const [part] = buildConversationContext([
      turn({ reference: 'task_1', prompt: 'First message' }),
      turn({ reference: 'task_2', prompt: 'Second message' }),
      turn({ reference: 'task_3', prompt: 'Third message' }),
    ]);

    const first = part.content.indexOf('First message');
    const second = part.content.indexOf('Second message');
    const third = part.content.indexOf('Third message');
    expect(first).toBeGreaterThan(-1);
    expect(first).toBeLessThan(second);
    expect(second).toBeLessThan(third);
  });

  it('reports a failed earlier turn by its failure reason, not a fabricated answer', () => {
    const [part] = buildConversationContext([
      turn({
        answer: null,
        failureReason: 'The agent reported completion but made no change to the working tree.',
      }),
    ]);

    expect(part.content).toContain('failed');
    expect(part.content).toContain('made no change to the working tree');
  });

  it('names a change task\'s plan and modified files, not just the chat shape', () => {
    const [part] = buildConversationContext([
      turn({
        kind: 'change',
        prompt: 'Add a delivery note field',
        answer: null,
        planSummary: 'Add a text field to stock.picking for delivery notes',
        modifiedPaths: ['models/stock_picking.py', 'views/stock_picking_views.xml'],
      }),
    ]);

    expect(part.content).toContain('Add a text field to stock.picking');
    expect(part.content).toContain('models/stock_picking.py');
    expect(part.content).toContain('views/stock_picking_views.xml');
  });

  it('keeps only the most recent maxTurns, newest-first is what the caller already sliced', () => {
    const turns = [1, 2, 3].map((n) => turn({ reference: `task_${n}`, prompt: `Message ${n}` }));
    const [part] = buildConversationContext(turns, {
      ...DEFAULT_CONVERSATION_BUDGET,
      maxTurns: 2,
    });

    expect(part.content).not.toContain('Message 1');
    expect(part.content).toContain('Message 2');
    expect(part.content).toContain('Message 3');
  });

  it('shortens an over-budget turn rather than dropping it outright', () => {
    const long = 'x'.repeat(10_000);
    const [part] = buildConversationContext(
      [turn({ prompt: long, answer: long })],
      { ...DEFAULT_CONVERSATION_BUDGET, maxPromptChars: 100, maxAnswerChars: 100 },
    );

    expect(part.content).toContain('shortened');
    expect(part.content.length).toBeLessThan(long.length);
  });

  it('drops the oldest turns and says how many were omitted when the total budget is tight', () => {
    const turns = [1, 2, 3, 4].map((n) =>
      turn({ reference: `task_${n}`, prompt: `Message ${n}`.repeat(200), answer: 'ok' }),
    );
    const [part] = buildConversationContext(turns, {
      ...DEFAULT_CONVERSATION_BUDGET,
      maxChars: 1500,
    });

    expect(part.content).toMatch(/older message\(s\) are not included/);
    // The newest turn must survive even under a tight budget.
    expect(part.content).toContain('Message 4');
  });

  it('never fabricates an answer for a turn that has none and did not fail', () => {
    const [part] = buildConversationContext([turn({ answer: null, failureReason: null })]);
    expect(part.content).toContain('no answer recorded');
  });
});
