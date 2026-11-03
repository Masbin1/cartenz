import { customModelNamesIn, inferOdooTarget, resolveOdooTarget, searchTermsFor } from './odoo-target';

describe('inferOdooTarget', () => {
  it('maps prompt vocabulary to a model', () => {
    expect(inferOdooTarget('Add a field to the Sales Order').model).toBe('sale.order');
    expect(inferOdooTarget('Fix the invoice tax rounding').model).toBe('account.move');
    expect(inferOdooTarget('Show the customer reference on contacts').model).toBe('res.partner');
    expect(inferOdooTarget('Delivery picking label').model).toBe('stock.picking');
    expect(inferOdooTarget('Employee equipment register').model).toBe('hr.employee');
    expect(inferOdooTarget('Purchase order approval').model).toBe('purchase.order');
  });

  it('falls back rather than guessing when nothing matches', () => {
    expect(inferOdooTarget('Make the thing better').model).toBe('res.config.settings');
  });

  it('is case insensitive', () => {
    expect(inferOdooTarget('ADD A FIELD TO THE SALES ORDER').model).toBe('sale.order');
  });

  it('supplies the search terms the analysis step uses', () => {
    expect(searchTermsFor('Add a field to the Sales Order')).toEqual(['sale.order']);
  });
});

describe('customModelNamesIn', () => {
  it('finds a custom model technical name', () => {
    expect(customModelNamesIn('list the fields on x_nota_pk please')).toEqual(['x_nota_pk']);
  });

  it('is case insensitive and dedupes', () => {
    expect(customModelNamesIn('X_Nota_PK and x_nota_pk again')).toEqual(['x_nota_pk']);
  });

  it('finds several distinct names in first-appearance order', () => {
    expect(customModelNamesIn('x_hpp_batch then x_nota_pk then x_hpp_batch again')).toEqual([
      'x_hpp_batch',
      'x_nota_pk',
    ]);
  });

  it('returns nothing for text with no custom model name', () => {
    expect(customModelNamesIn('ya bikinkan sample datanya dong')).toEqual([]);
  });
});

/**
 * ADR-091: task_819929 asked "ya bikinkan sample datanya dong" right after
 * the agent had listed x_nota_pk for the person in its own previous answer.
 * inferOdooTarget alone cannot see that - it only reads the current prompt,
 * and has no keyword for a custom model at all - so it fell back to
 * res.config.settings and the plan was built against the wrong schema.
 */
describe('resolveOdooTarget', () => {
  it('prefers a custom model named in the current prompt', () => {
    expect(resolveOdooTarget('add 10 sample rows to x_nota_pk').model).toBe('x_nota_pk');
  });

  it('falls back to a custom model named in an earlier turn (task_819929)', () => {
    const history = [
      'oke coba berikan saya list model yang ada pada project ini cobaa',
      'Model custom (x_) di project ini:\n- x_nota_pk — Nota Timbang Hasil PK\n- x_hpp_batch — HPP Batch Produksi\n\nJadi model x_nota_pk memang ada dan benar.',
    ];
    expect(resolveOdooTarget('ya bikinkan sample datanya dong', history).model).toBe('x_nota_pk');
  });

  it('prefers the most recently mentioned custom model across several turns', () => {
    const history = [
      'add a field to x_hpp_batch',
      'done',
      'now do the same for x_nota_pk',
      'done',
    ];
    expect(resolveOdooTarget('bikinkan sample datanya dong', history).model).toBe('x_nota_pk');
  });

  it('prefers the current prompt over history when both name a custom model', () => {
    const history = ['tell me about x_hpp_batch'];
    expect(resolveOdooTarget('add sample data to x_nota_pk', history).model).toBe('x_nota_pk');
  });

  it('falls through to inferOdooTarget when no custom model is named anywhere', () => {
    const history = ['oke coba berikan saya list model yang ada pada project ini'];
    expect(resolveOdooTarget('Add a field to the Sales Order', history).model).toBe('sale.order');
  });

  it('does not let a stale custom-model mention override a later standard-model pivot', () => {
    // History names a custom model, but the *current* prompt clearly names a
    // standard one - the standard-model table on the current prompt wins,
    // since resolveOdooTarget only falls back to history when the current
    // prompt itself names nothing.
    const history = ['add a field to x_nota_pk', 'done'];
    expect(resolveOdooTarget('now add a field to the Sales Order', history).model).toBe(
      'sale.order',
    );
  });

  it('falls back to res.config.settings with no history and no match', () => {
    expect(resolveOdooTarget('Make the thing better').model).toBe('res.config.settings');
  });
});
