import { keepCataloguedConfiguration, type ConfigurationItem } from './odoo-setup-plan';
import type { OdooSetupCatalog } from './odoo-setup-catalog';

const catalog: OdooSetupCatalog = {
  settings: [{ field: 'group_stock_production_lot', label: 'Lots & Serial Numbers', module: 'stock' }],
  records: [
    {
      model: 'product.attribute',
      label: 'Attribute',
      requiresModule: 'product',
      fields: [
        { field: 'name' },
        { field: 'create_variant', values: ['always', 'dynamic', 'no_variant'] },
      ],
    },
    {
      model: 'res.company',
      label: 'Company',
      requiresModule: 'base',
      fields: [{ field: 'name' }, { field: 'currency_id' }],
    },
  ],
  languageInstallAvailable: true,
};

const item = (overrides: Partial<ConfigurationItem>): ConfigurationItem => ({
  kind: 'setting',
  reason: 'brief',
  ...overrides,
});

describe('keepCataloguedConfiguration (ADR-073)', () => {
  it('keeps a catalogued setting and drops an invented one', () => {
    const kept = keepCataloguedConfiguration(
      [
        item({ settingField: 'group_stock_production_lot' }),
        item({ settingField: 'group_show_uom_price' }),
      ],
      catalog,
    );
    expect(kept.map((k) => k.settingField)).toEqual(['group_stock_production_lot']);
  });

  it('keeps a record with known fields and legal selection values only', () => {
    const kept = keepCataloguedConfiguration(
      [
        item({ kind: 'record', model: 'product.attribute', values: { name: 'Tebal', create_variant: 'always' } }),
        item({ kind: 'record', model: 'product.attribute', values: { name: 'X', create_variant: 'sometimes' } }),
        item({ kind: 'record', model: 'product.attribute', values: { name: 'X', sequence: 1 } }),
        item({ kind: 'record', model: 'ir.config_parameter', values: { key: 'x' } }),
      ],
      catalog,
    );
    expect(kept).toHaveLength(1);
    expect(kept[0].values).toEqual({ name: 'Tebal', create_variant: 'always' });
  });

  it('checks company fields against the res.company entry', () => {
    const kept = keepCataloguedConfiguration(
      [
        item({ kind: 'company', values: { currency_id: 'IDR' } }),
        item({ kind: 'company', values: { vat: '01.234' } }),
      ],
      catalog,
    );
    expect(kept).toHaveLength(1);
  });

  it('accepts a well-formed language code only', () => {
    const kept = keepCataloguedConfiguration(
      [item({ kind: 'language', languageCode: 'id_ID' }), item({ kind: 'language', languageCode: 'id; DROP' })],
      catalog,
    );
    expect(kept.map((k) => k.languageCode)).toEqual(['id_ID']);
  });
});
