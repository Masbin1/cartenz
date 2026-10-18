import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSetupCatalog, parseGroupToggles } from './odoo-setup-catalog';
import type { CatalogModule } from './odoo-module-catalog';

describe('parseGroupToggles (ADR-073)', () => {
  it('reads an inline positional label', () => {
    const source = `
class ResConfigSettings(models.TransientModel):
    _inherit = 'res.config.settings'
    group_product_variant = fields.Boolean("Variants", implied_group='product.group_product_variant')
`;
    expect(parseGroupToggles(source)).toEqual([
      { field: 'group_product_variant', label: 'Variants' },
    ]);
  });

  it('reads a label written on the next line', () => {
    const source = `
    group_sale_order_template = fields.Boolean(
        "Quotation Templates", implied_group='sale_management.group_sale_order_template')
`;
    expect(parseGroupToggles(source)).toEqual([
      { field: 'group_sale_order_template', label: 'Quotation Templates' },
    ]);
  });

  it('reads a string= keyword label', () => {
    const source = `
    group_cash_rounding = fields.Boolean(string="Cash Rounding", implied_group='account.group_cash_rounding')
    group_multi_currency = fields.Boolean(string='Multi-Currencies',
        implied_group='base.group_multi_currency',
        help="Allows to work in a multi currency environment")
`;
    expect(parseGroupToggles(source)).toEqual([
      { field: 'group_cash_rounding', label: 'Cash Rounding' },
      { field: 'group_multi_currency', label: 'Multi-Currencies' },
    ]);
  });

  it('falls back to the field name when there is no label, and ignores parens in strings', () => {
    const source = `
    group_use_lead = fields.Boolean(implied_group='crm.group_use_lead')
    group_x = fields.Boolean("Odd (label)", help="a ) inside")
    module_crm = fields.Boolean("CRM")
`;
    expect(parseGroupToggles(source)).toEqual([
      { field: 'group_use_lead', label: 'group_use_lead' },
      { field: 'group_x', label: 'Odd (label)' },
    ]);
  });
});

describe('buildSetupCatalog settings menu (ADR-073)', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'setup-catalog-'));
    const write = async (path: string, body: string) => {
      await mkdir(join(root, path, '..'), { recursive: true });
      await writeFile(join(root, path), body);
    };
    await write('sale/__manifest__.py', "{'name': 'Sales'}");
    // `sale` keeps its settings under wizard/, not models/.
    await write(
      'sale/wizard/res_config_settings.py',
      "    group_discount_per_so_line = fields.Boolean(\"Discounts\", implied_group='sale.group_discount_per_so_line')\n",
    );
    await write('payment/__manifest__.py', "{'name': 'Payment'}");
    await write(
      'payment/wizards/res_config_settings.py',
      '    group_payment_x = fields.Boolean(string="Payment X")\n',
    );
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('offers toggles from wizard/ and wizards/ settings files', async () => {
    const catalogue = [
      { technicalName: 'sale' },
      { technicalName: 'payment' },
    ] as unknown as CatalogModule[];
    const catalog = await buildSetupCatalog([root], ['sale', 'payment'], catalogue);
    expect(catalog.settings.map((s) => s.field)).toEqual([
      'group_discount_per_so_line',
      'group_payment_x',
    ]);
  });
});
