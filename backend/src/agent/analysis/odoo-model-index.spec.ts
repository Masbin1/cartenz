import {
  rankCandidates,
  readModelDeclarations,
  relevanceTo,
} from './odoo-model-index';

/**
 * Model-aware file ranking (ADR-025).
 *
 * The case that produced this: a change to `sale.order` was planned in a
 * dashboard file that mentions the words, while the file that actually begins
 * `_inherit = 'sale.order'` was ignored. The tests below are written from the
 * real repository's shapes rather than invented ones.
 */
describe('readModelDeclarations', () => {
  it('reads a definition and an extension', () => {
    const source = [
      'from odoo import fields, models',
      '',
      'class SaleOrder(models.Model):',
      "    _inherit = 'sale.order'",
      '',
      'class Courier(models.Model):',
      '    _name = "omnisurge.courier"',
    ].join('\n');

    const result = readModelDeclarations('a.py', source);
    expect(result.extends).toEqual(['sale.order']);
    expect(result.defines).toEqual(['omnisurge.courier']);
  });

  it('reads a list of inherited models', () => {
    const source = "class X(models.Model):\n    _inherit = ['sale.order', \"mail.thread\"]";
    expect(readModelDeclarations('a.py', source).extends).toEqual(['sale.order', 'mail.thread']);
  });

  it('reads a list spread over several lines, which is how Odoo code is written', () => {
    const source = [
      'class X(models.Model):',
      '    _inherit = [',
      "        'sale.order',",
      "        'mail.activity.mixin',",
      '    ]',
    ].join('\n');

    expect(readModelDeclarations('a.py', source).extends).toEqual([
      'sale.order',
      'mail.activity.mixin',
    ]);
  });

  it('ignores the model name appearing in a comment or a string', () => {
    const source = [
      '# This dashboard aggregates sale.order records.',
      'DOMAIN = "[(\'model\', \'=\', \'sale.order\')]"',
      'class Dashboard(models.Model):',
      "    _name = 'linkederp.dashboard'",
    ].join('\n');

    const result = readModelDeclarations('dashboard.py', source);
    expect(result.extends).toEqual([]);
    expect(result.defines).toEqual(['linkederp.dashboard']);
  });

  it('returns nothing for a file with no model at all', () => {
    const result = readModelDeclarations('utils.py', 'def helper():\n    return 1');
    expect(result.defines).toEqual([]);
    expect(result.extends).toEqual([]);
  });
});

describe('relevanceTo', () => {
  const declares = (source: string) => readModelDeclarations('a.py', source);

  it('ranks extending above mentioning', () => {
    const extending = "class X(models.Model):\n    _inherit = 'sale.order'";
    const mentioning = '# reads sale.order somewhere';

    expect(relevanceTo(declares(extending), 'sale.order', extending)).toBe('extends');
    expect(relevanceTo(declares(mentioning), 'sale.order', mentioning)).toBe('mentions');
  });

  it('calls a file that neither declares nor mentions the model unrelated', () => {
    const source = 'def helper():\n    return 1';
    expect(relevanceTo(declares(source), 'sale.order', source)).toBe('unrelated');
  });
});

describe('rankCandidates', () => {
  it('puts the file that extends the model first, whatever order it arrived in', () => {
    // The real failure: dashboard.py came first because the walker returned it
    // first, and a text search could not tell the two apart.
    const ranked = rankCandidates(
      [
        {
          path: 'linkederp_dashboard_studio/models/dashboard.py',
          source: '# aggregates sale.order\nclass D(models.Model):\n    _name = "l.dashboard"',
        },
        {
          path: 'linkederp_sales_modifier/models/sale_order.py',
          source: "class SaleOrder(models.Model):\n    _inherit = 'sale.order'",
        },
      ],
      'sale.order',
    );

    expect(ranked[0].path).toBe('linkederp_sales_modifier/models/sale_order.py');
    expect(ranked[0].relevance).toBe('extends');
    expect(ranked[1].relevance).toBe('mentions');
  });

  it('keeps the caller order within a band', () => {
    const ranked = rankCandidates(
      [
        { path: 'first.py', source: "class A(models.Model):\n    _inherit = 'sale.order'" },
        { path: 'second.py', source: "class B(models.Model):\n    _inherit = 'sale.order'" },
      ],
      'sale.order',
    );

    expect(ranked.map((entry) => entry.path)).toEqual(['first.py', 'second.py']);
  });

  it('returns an empty list for no candidates rather than throwing', () => {
    expect(rankCandidates([], 'sale.order')).toEqual([]);
  });

  it('prefers the conventionally named file among files that all extend the model', () => {
    // Both of these extend sale.order on the real repository. Nothing in the code
    // says which is the right home for a general field; the filename is the only
    // signal there is, and Odoo convention is clear about it.
    const inherits = "class X(models.Model):\n    _inherit = 'sale.order'";
    const ranked = rankCandidates(
      [
        { path: 'linkederp_dashboard_studio/models/sale_order_sla.py', source: inherits },
        { path: 'linkederp_sales_modifier/models/sale_order.py', source: inherits },
      ],
      'sale.order',
    );

    expect(ranked[0].path).toBe('linkederp_sales_modifier/models/sale_order.py');
  });

  it('never lets the filename beat the declaration', () => {
    // A file called sale_order.py that does not extend sale.order must not
    // outrank one that does. The convention is a tiebreak, not evidence.
    const ranked = rankCandidates(
      [
        { path: 'anywhere/models/sale_order.py', source: '# mentions sale.order only' },
        { path: 'other/models/extension.py', source: "    _inherit = 'sale.order'" },
      ],
      'sale.order',
    );

    expect(ranked[0].path).toBe('other/models/extension.py');
    expect(ranked[0].relevance).toBe('extends');
  });
});

describe('XML view files', () => {
  it('reads the model a view record applies to', () => {
    const source = [
      '<odoo>',
      '  <record id="sale_order_form" model="ir.ui.view">',
      '    <field name="model">sale.order</field>',
      '  </record>',
      '</odoo>',
    ].join('\n');

    expect(readModelDeclarations('views/sale_order_views.xml', source).extends).toEqual([
      'sale.order',
    ]);
  });

  it('ignores the record type, which is not the business model', () => {
    // model="ir.ui.view" is what kind of record this is, not what it concerns.
    const source = '<record id="x" model="ir.ui.view"><field name="model">ir.ui.view</field></record>';
    expect(readModelDeclarations('views/x.xml', source).extends).toEqual([]);
  });

  it('ranks a view that declares the model above one that only mentions it', () => {
    // Both of these exist on the real repository and both contain the words.
    const declaring = '<field name="model">sale.order</field>';
    const mentioning = '<!-- a dashboard that reads sale.order counts -->';

    const ranked = rankCandidates(
      [
        { path: 'linkederp_dashboard_studio/data/sales_crm_dashboard.xml', source: mentioning },
        { path: 'linkederp_sales_modifier/views/sale_order_views.xml', source: declaring },
      ],
      'sale.order',
    );

    expect(ranked[0].path).toBe('linkederp_sales_modifier/views/sale_order_views.xml');
    expect(ranked[1].relevance).toBe('mentions');
  });

  it('prefers the conventionally named view among views that all declare the model', () => {
    const declaring = '<field name="model">sale.order</field>';
    const ranked = rankCandidates(
      [
        { path: 'linkederp_dashboard_studio/views/sale_order_sla_views.xml', source: declaring },
        { path: 'linkederp_sales_modifier/views/sale_order_views.xml', source: declaring },
      ],
      'sale.order',
    );

    expect(ranked[0].path).toBe('linkederp_sales_modifier/views/sale_order_views.xml');
  });
});
