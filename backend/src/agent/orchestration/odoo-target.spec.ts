import { inferOdooTarget, searchTermsFor } from './odoo-target';

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
