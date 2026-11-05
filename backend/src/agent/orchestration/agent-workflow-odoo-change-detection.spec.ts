import { CHANGING_ODOO_TOOLS, describeOdooChange } from './agent-workflow';

/**
 * ADR-093: task_551621 drove the signed-in browser through "Save manually"
 * on two new products and a new Sales Order - real writes - and was still
 * reported as "Nothing was changed on the instance", because
 * CHANGING_ODOO_TOOLS had never contained a browser tool. A write made
 * through the browser is exactly as real as one made through
 * odoo_create_records.
 */
describe('CHANGING_ODOO_TOOLS (ADR-093)', () => {
  it('counts browser_click and browser_type as changes', () => {
    expect(CHANGING_ODOO_TOOLS).toContain('browser_click');
    expect(CHANGING_ODOO_TOOLS).toContain('browser_type');
  });

  it('does not count browser_navigate or browser_snapshot - they read a screen, not change it', () => {
    expect(CHANGING_ODOO_TOOLS).not.toContain('browser_navigate');
    expect(CHANGING_ODOO_TOOLS).not.toContain('browser_snapshot');
  });

  it('still counts the original RPC write tools', () => {
    expect(CHANGING_ODOO_TOOLS).toEqual(
      expect.arrayContaining([
        'odoo_create_field',
        'odoo_create_model',
        'odoo_add_field_to_view',
        'odoo_create_records',
        'odoo_update_records',
      ]),
    );
  });
});

describe('describeOdooChange (ADR-093)', () => {
  it('describes a browser_click by the screen it acted on', () => {
    expect(
      describeOdooChange('browser_click', { url: 'https://katoka.odoo.com/odoo/sales/new', title: 'New' }),
    ).toBe('Acted in the browser on New.');
  });

  it('describes a browser_type the same way', () => {
    expect(
      describeOdooChange('browser_type', { url: 'https://katoka.odoo.com/odoo/sales/new', title: 'New' }),
    ).toBe('Acted in the browser on New.');
  });

  it('falls back to the url when there is no title', () => {
    expect(describeOdooChange('browser_click', { url: 'https://katoka.odoo.com/odoo/sales/new' })).toBe(
      'Acted in the browser on https://katoka.odoo.com/odoo/sales/new.',
    );
  });

  it('still describes the original RPC tools as before', () => {
    expect(
      describeOdooChange('odoo_create_field', {
        field: 'x_max_discount',
        model: 'res.partner',
        fieldId: 19299,
      }),
    ).toBe('Created field x_max_discount on res.partner (id 19299).');
  });
});
