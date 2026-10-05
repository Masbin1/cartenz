import { validateCreateField, normalizeSelectionOptions } from './odoo-field-surface';

/**
 * The field surface (ADR-068 extension): `odoo_create_field` requests that
 * carry relation/selection data, refused locally with the same reason Odoo's
 * own `ir.model.fields.create` would raise, before anything leaves the
 * platform.
 */
describe('the odoo_online field surface', () => {
  const base = { model: 'sale.order', name: 'referensi', label: 'Referensi' };

  it('accepts a well-formed scalar field', () => {
    expect(validateCreateField({ ...base, type: 'char' })).toBeNull();
  });

  it('refuses an unsupported type', () => {
    expect(validateCreateField({ ...base, type: 'binary' })).toContain('not a supported field type');
  });

  it('requires relation for many2one', () => {
    const reason = validateCreateField({ ...base, type: 'many2one' });
    expect(reason).toContain('relation');
  });

  it('accepts many2one with a valid relation', () => {
    expect(
      validateCreateField({ ...base, type: 'many2one', relation: 'res.partner' }),
    ).toBeNull();
  });

  it('refuses a malformed relation model name', () => {
    expect(
      validateCreateField({ ...base, type: 'many2one', relation: 'Res Partner!' }),
    ).not.toBeNull();
  });

  it('requires relationField for one2many, in addition to relation', () => {
    expect(validateCreateField({ ...base, type: 'one2many', relation: 'res.partner' })).toContain(
      'relationField',
    );
    expect(
      validateCreateField({
        ...base,
        type: 'one2many',
        relation: 'res.partner',
        relationField: 'x_parent_id',
      }),
    ).toBeNull();
  });

  it('requires non-empty options for selection', () => {
    expect(validateCreateField({ ...base, type: 'selection' })).toContain('options');
    expect(validateCreateField({ ...base, type: 'selection', options: [] })).toContain('options');
  });

  it('accepts selection with well-formed options', () => {
    expect(
      validateCreateField({
        ...base,
        type: 'selection',
        options: [
          { value: 'draft', label: 'Draft' },
          { value: 'done', label: 'Done' },
        ],
      }),
    ).toBeNull();
  });

  it('refuses duplicate option values', () => {
    expect(
      validateCreateField({
        ...base,
        type: 'selection',
        options: [
          { value: 'draft', label: 'Draft' },
          { value: 'draft', label: 'Also draft' },
        ],
      }),
    ).toContain('unique');
  });

  it('refuses a malformed field name', () => {
    expect(validateCreateField({ ...base, name: 'Referensi!', type: 'char' })).not.toBeNull();
  });

  it('normalizes selection options by trimming', () => {
    expect(
      normalizeSelectionOptions([{ value: '  draft  ', label: '  Draft  ' }]),
    ).toEqual([{ value: 'draft', label: 'Draft' }]);
    expect(normalizeSelectionOptions(undefined)).toBeUndefined();
  });
});
