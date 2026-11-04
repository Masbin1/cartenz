import { buildPriorProgress, PRIOR_PROGRESS_LABEL, type PriorAction } from './prior-progress';

/**
 * ADR-092: task_131131 got as far as opening the Automation Rules screen,
 * was paused for browser_click's approval, and after "approved, continuing"
 * had no memory of the fields it had already created or the screen it had
 * already reached - it answered as if the task had just begun. This is the
 * prompt part that fixes that: the model's own earlier successful calls,
 * read back to it on resumption.
 */
describe('buildPriorProgress (ADR-092)', () => {
  it('returns nothing for an empty action list', () => {
    expect(buildPriorProgress([])).toEqual([]);
  });

  it('renders one numbered line per action, in order', () => {
    const actions: PriorAction[] = [
      {
        toolName: 'odoo_create_field',
        input: { model: 'res.partner', name: 'x_max_discount' },
        output: { field: 'x_max_discount', fieldId: 19299 },
      },
      {
        toolName: 'browser_navigate',
        input: { url: 'https://katoka.odoo.com/odoo/sales' },
        output: { url: 'https://katoka.odoo.com/odoo/sales', title: 'Quotations' },
      },
    ];

    const [part] = buildPriorProgress(actions);

    expect(part.label).toBe(PRIOR_PROGRESS_LABEL);
    expect(part.untrusted).toBe(false);
    expect(part.content).toContain('1. odoo_create_field(');
    expect(part.content).toContain('2. browser_navigate(');
    // The order must be preserved - a resumed task must see what happened
    // first before what happened second.
    expect(part.content.indexOf('odoo_create_field')).toBeLessThan(
      part.content.indexOf('browser_navigate'),
    );
  });

  it('tells the model not to repeat these calls and to continue from them', () => {
    const [part] = buildPriorProgress([{ toolName: 'odoo_list_fields', input: {}, output: {} }]);
    expect(part.content).toContain('Do not repeat them');
    expect(part.content).toContain('continue from');
  });

  it('notes how many earlier calls were omitted past the action budget', () => {
    const actions: PriorAction[] = Array.from({ length: 5 }, (_, i) => ({
      toolName: `tool_${i}`,
      input: {},
      output: {},
    }));

    const [part] = buildPriorProgress(actions, { maxActions: 3, maxChars: 8_000 });

    expect(part.content).toContain('tool_0');
    expect(part.content).toContain('tool_2');
    expect(part.content).not.toContain('tool_3');
    expect(part.content).toContain('(2 earlier call(s) omitted for length.)');
  });

  it('truncates when the rendered content exceeds the character budget', () => {
    const actions: PriorAction[] = [
      { toolName: 'big_tool', input: { blob: 'x'.repeat(5_000) }, output: {} },
    ];

    const [part] = buildPriorProgress(actions, { maxActions: 60, maxChars: 100 });

    expect(part.content.length).toBeLessThan(200);
    expect(part.content).toContain('(truncated)');
  });
});
