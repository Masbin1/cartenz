import {
  applyEdit,
  assertNotDestructiveRewrite,
  DestructiveRewriteError,
  EditNotApplicableError,
  EmptyEditTargetError,
} from './write-safety';

/**
 * Write guards (ADR-022).
 *
 * Written from a real failure rather than from imagination: on the first run
 * against a customer repository, update_file replaced a 1101-line Odoo module
 * with a 68-line stub, because the whole-file contract means anything the caller
 * does not reproduce is deleted. These tests assert the refusal, not the success,
 * because a guard that only checked the happy case would pass against a guard
 * that checks nothing.
 */
describe('assertNotDestructiveRewrite', () => {
  const lines = (count: number, text = 'line') =>
    Array.from({ length: count }, (_, index) => `${text} ${index}`).join('\n');

  it('refuses the failure that produced it: 1101 lines replaced by 68', () => {
    expect(() => assertNotDestructiveRewrite('models/dashboard.py', lines(1101), lines(68)))
      .toThrow(DestructiveRewriteError);
  });

  it('names the file and both line counts, so the refusal is actionable', () => {
    let caught: DestructiveRewriteError | null = null;
    try {
      assertNotDestructiveRewrite('models/dashboard.py', lines(1101), lines(68));
    } catch (error) {
      caught = error as DestructiveRewriteError;
    }

    expect(caught?.path).toBe('models/dashboard.py');
    expect(caught?.previousLines).toBe(1101);
    expect(caught?.nextLines).toBe(68);
    expect(caught?.message).toContain('1033');
    expect(caught?.message).toContain('edit_file');
  });

  it('permits a small file to be rewritten entirely', () => {
    // A short __init__.py or manifest is plausibly rewritten on purpose, and
    // refusing that would make the guard a nuisance rather than a protection.
    expect(() => assertNotDestructiveRewrite('models/__init__.py', lines(12), lines(2)))
      .not.toThrow();
  });

  it('permits a large file to grow', () => {
    expect(() => assertNotDestructiveRewrite('models/sale_order.py', lines(400), lines(430)))
      .not.toThrow();
  });

  it('permits a large file to shrink modestly', () => {
    // Removing a method is legitimate. The guard is about losing most of a file.
    expect(() => assertNotDestructiveRewrite('models/sale_order.py', lines(400), lines(320)))
      .not.toThrow();
  });

  it('refuses at the halfway point, so the boundary is not merely asserted', () => {
    expect(() => assertNotDestructiveRewrite('models/sale_order.py', lines(400), lines(200)))
      .toThrow(DestructiveRewriteError);
    expect(() => assertNotDestructiveRewrite('models/sale_order.py', lines(400), lines(201)))
      .not.toThrow();
  });

  it('refuses a file emptied to nothing', () => {
    expect(() => assertNotDestructiveRewrite('models/dashboard.py', lines(500), '')).toThrow(
      DestructiveRewriteError,
    );
  });

  it('ignores byte size, counting lines', () => {
    // Reformatting can change bytes greatly while keeping every line, and losing
    // lines is the failure being guarded.
    const wide = Array.from({ length: 200 }, () => 'x'.repeat(400)).join('\n');
    const narrow = Array.from({ length: 200 }, () => 'x').join('\n');
    expect(() => assertNotDestructiveRewrite('models/wide.py', wide, narrow)).not.toThrow();
  });
});

describe('applyEdit', () => {
  const file = [
    'class SaleOrder(models.Model):',
    "    _inherit = 'sale.order'",
    '',
    "    delivery_window = fields.Selection(",
    "        selection=[('morning', 'Morning')],",
    "        string='Delivery Window',",
    '    )',
    '',
    '    def _compute_total(self):',
    '        return 0',
  ].join('\n');

  it('replaces one region and leaves the rest byte-for-byte', () => {
    const result = applyEdit(
      'models/sale_order.py',
      file,
      "    def _compute_total(self):\n        return 0",
      "    def _compute_total(self):\n        return sum(self.order_line.mapped('price_subtotal'))",
    );

    expect(result.content).toContain('delivery_window = fields.Selection(');
    expect(result.content).toContain("_inherit = 'sale.order'");
    expect(result.content).toContain("sum(self.order_line.mapped('price_subtotal'))");
    expect(result.content).not.toContain('return 0');
    // The point of the tool: nothing outside the named region can be lost.
    expect(result.content.split('\n')).toHaveLength(file.split('\n').length);
  });

  it('refuses text that is not there, changing nothing', () => {
    expect(() =>
      applyEdit('models/sale_order.py', file, "_inherit = 'purchase.order'", 'x'),
    ).toThrow(EditNotApplicableError);
  });

  it('refuses an ambiguous target rather than guessing which one', () => {
    // An edit applied to the wrong one of several similar blocks is harder to
    // notice than an edit that did not happen.
    const repeated = 'x = 1\ny = 2\nx = 1\n';
    expect(() => applyEdit('models/a.py', repeated, 'x = 1', 'x = 3')).toThrow(
      EditNotApplicableError,
    );
  });

  it('reports how many times an ambiguous target appeared', () => {
    let caught: EditNotApplicableError | null = null;
    try {
      applyEdit('models/a.py', 'a\na\na\n', 'a', 'b');
    } catch (error) {
      caught = error as EditNotApplicableError;
    }
    expect(caught?.reason).toBe('ambiguous');
    expect(caught?.message).toContain('2 times');
  });

  it('refuses an empty target instead of looping forever', () => {
    // An empty needle matches at every position and advances the scan by nothing.
    expect(() => applyEdit('models/a.py', file, '', 'anything')).toThrow(EmptyEditTargetError);
  });

  it('removes the found text when the replacement is empty', () => {
    const result = applyEdit('models/a.py', 'keep\nremove me\nkeep\n', 'remove me\n', '');
    expect(result.content).toBe('keep\nkeep\n');
    expect(result.linesRemoved).toBe(2);
  });

  it('counts overlapping occurrences the way they would be replaced', () => {
    // 'aa' appears twice in 'aaaa' when scanning past each match, not three times.
    expect(() => applyEdit('models/a.py', 'aaaa', 'aa', 'b')).toThrow(EditNotApplicableError);
    expect(applyEdit('models/a.py', 'aaa', 'aa', 'b').content).toBe('ba');
  });

  it('matches indentation exactly, because Python depends on it', () => {
    expect(() =>
      applyEdit('models/a.py', file, "def _compute_total(self):\n    return 0", 'x'),
    ).toThrow(EditNotApplicableError);
  });
});
