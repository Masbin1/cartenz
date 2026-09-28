import {
  normalizeModelLabel,
  normalizeModelName,
  validateCreateModel,
} from './odoo-model-surface';

/**
 * The model surface (ADR-068).
 *
 * The property under test is that a create-model request is refused locally, with
 * a reason a model can act on, for every shape Odoo would have rejected — and
 * that nothing stricter than Odoo's own rule is imposed, since a refusal that is
 * not Odoo's would be the platform inventing a limitation.
 */
describe('the odoo_online model surface', () => {
  const valid = { model: 'x_servis', label: 'Servis' };

  it('accepts a well-formed request', () => {
    expect(validateCreateModel(valid)).toBeNull();
  });

  it('accepts a dotted technical name the way Odoo does', () => {
    // Odoo's object-name check allows dots; a manual model is not required to be
    // flat, and refusing one would be a rule Odoo does not have.
    expect(validateCreateModel({ model: 'x_servis.line', label: 'Servis Line' })).toBeNull();
    expect(validateCreateModel({ model: 'x_servis_line', label: 'Servis Line' })).toBeNull();
  });

  it('refuses a dot that leaves an empty segment', () => {
    for (const model of ['x_servis.', 'x_servis..line', 'x_.line']) {
      expect(validateCreateModel({ model, label: 'Servis' })).not.toBeNull();
    }
  });

  it('refuses a name without the x_ prefix, naming the rule', () => {
    const reason = validateCreateModel({ model: 'servis', label: 'Servis' });
    expect(reason).toContain('x_');
  });

  it('refuses uppercase and characters Odoo will not accept', () => {
    for (const model of ['x_Servis', 'x-servis', 'x servis', 'x_servis!', 'x_']) {
      expect(validateCreateModel({ model, label: 'Servis' })).not.toBeNull();
    }
  });

  it('refuses a name that would collide with a module model namespace', () => {
    // A dot-prefixed name would read as another module's model. The prefix rule
    // is what makes this unreachable, and it is asserted rather than assumed.
    for (const model of ['sale.order', 'ir.model', 'x_servis.extra ok']) {
      expect(validateCreateModel({ model, label: 'Servis' })).not.toBeNull();
    }
  });

  it('requires a non-empty label', () => {
    expect(validateCreateModel({ model: 'x_servis', label: '' })).not.toBeNull();
    expect(validateCreateModel({ model: 'x_servis', label: '   ' })).not.toBeNull();
    expect(validateCreateModel({ model: 'x_servis' })).not.toBeNull();
  });

  it('refuses a label longer than the schema allows', () => {
    expect(
      validateCreateModel({ model: 'x_servis', label: 'a'.repeat(201) }),
    ).not.toBeNull();
    expect(
      validateCreateModel({ model: 'x_servis', label: 'a'.repeat(200) }),
    ).toBeNull();
  });

  it('refuses input that is not an object', () => {
    for (const input of [null, undefined, 'x_servis', 42, []]) {
      expect(validateCreateModel(input)).not.toBeNull();
    }
  });

  it('normalizes by trimming rather than by rewriting', () => {
    // A name is not silently lowercased: a caller that asked for X_Servis gets a
    // refusal above, not a model it did not name.
    expect(normalizeModelName('  x_servis  ')).toBe('x_servis');
    expect(normalizeModelLabel('  Servis  ')).toBe('Servis');
  });
});
