/**
 * The field surface of an Odoo Online instance: what an `odoo_create_field`
 * request may say, checked before anything leaves the platform.
 *
 * Added alongside `odoo-model-surface.ts` because the original `odoo_create_field`
 * tool only ever sent `name`, `field_description`, `ttype`, `required` and
 * `model_id` to `ir.model.fields.create` (see `OdooOnlineClient.createField`).
 * That is enough for a scalar field (char, text, integer, ...) but Odoo silently
 * drops a relational field with no target, or raises `UserError` on commit in
 * ways no earlier validation caught — `ir.model.fields.create` in
 * `odoo/addons/base/models/ir_model.py` raises "Model %s does not exist!" when
 * `relation` is missing/wrong for a many2one/one2many/many2many, and "Many2one
 * %(field)s on model %(model)s does not exist!" when a one2many's
 * `relation_field` does not name a real many2one on the target model. A
 * selection field with no options is legal to create but useless — nothing can
 * ever be chosen — so it is refused here with a reason rather than silently
 * accepted.
 *
 * Kept free of Nest and I/O so the policy is tested on its own, matching
 * `odoo-model-surface.ts`.
 */

/** Field types this tool creates. Matches what `createField` below sends. */
export const SUPPORTED_FIELD_TYPES = [
  'char',
  'text',
  'html',
  'integer',
  'float',
  'monetary',
  'boolean',
  'date',
  'datetime',
  'selection',
  'many2one',
  'one2many',
  'many2many',
] as const;

export type SupportedFieldType = (typeof SUPPORTED_FIELD_TYPES)[number];

/** Field types that point at another model and therefore need `relation`. */
const RELATIONAL_TYPES = new Set<SupportedFieldType>(['many2one', 'one2many', 'many2many']);

const FIELD_NAME = /^[a-z0-9_]+$/;
const ODOO_MODEL_NAME = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/;
const MAX_LABEL_LENGTH = 200;
const MAX_SELECTION_OPTIONS = 50;

export interface SelectionOptionInput {
  readonly value: string;
  readonly label: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSupportedType(value: string): value is SupportedFieldType {
  return (SUPPORTED_FIELD_TYPES as readonly string[]).includes(value);
}

/**
 * Validates an `odoo_create_field` request. Returns a reason, or null.
 *
 * Mirrors what Odoo itself requires rather than inventing a stricter rule: a
 * many2one/one2many/many2many without `relation` is refused here with the same
 * reason Odoo's own `UserError` would have given, just before the round trip
 * instead of after it; a one2many without `relationField` the same way. A
 * selection with no options is refused because Studio never offers one either
 * — the field would exist with no value anyone could pick.
 */
export function validateCreateField(input: unknown): string | null {
  if (!isPlainObject(input)) return 'the input must be an object';

  const model = input.model;
  if (typeof model !== 'string' || !ODOO_MODEL_NAME.test(model.trim())) {
    return 'model is required: the technical model name, e.g. "sale.order"';
  }

  const name = input.name;
  if (typeof name !== 'string' || name.trim().length === 0) {
    return 'name is required: the technical field name without the "x_" prefix, e.g. "referensi"';
  }
  if (!FIELD_NAME.test(name.trim())) {
    return `"${name}" is not a valid field name. Use lowercase letters, digits and underscores only, e.g. "referensi"`;
  }

  const label = input.label;
  if (typeof label !== 'string' || label.trim().length === 0) {
    return 'label is required: the human label shown in the UI, e.g. "Referensi"';
  }
  if (label.trim().length > MAX_LABEL_LENGTH) {
    return `label must be at most ${MAX_LABEL_LENGTH} characters`;
  }

  const type = input.type;
  if (typeof type !== 'string' || !isSupportedType(type)) {
    return (
      `"${String(type)}" is not a supported field type. Use one of: ` +
      `${SUPPORTED_FIELD_TYPES.join(', ')}.`
    );
  }

  if (RELATIONAL_TYPES.has(type)) {
    const relation = input.relation;
    if (typeof relation !== 'string' || relation.trim().length === 0) {
      return (
        `type "${type}" targets another model and requires "relation": the technical ` +
        'name of that model, e.g. "res.partner".'
      );
    }
    if (!ODOO_MODEL_NAME.test(relation.trim())) {
      return `"${relation}" is not a valid Odoo model name for "relation"`;
    }

    if (type === 'one2many') {
      const relationField = input.relationField;
      if (typeof relationField !== 'string' || relationField.trim().length === 0) {
        return (
          'type "one2many" requires "relationField": the technical name of the ' +
          `many2one field on "${relation}" that points back to this model, e.g. "x_parent_id".`
        );
      }
      if (!FIELD_NAME.test(relationField.trim())) {
        return `"${relationField}" is not a valid field name for "relationField"`;
      }
    }
  }

  if (type === 'selection') {
    const options = input.options;
    if (!Array.isArray(options) || options.length === 0) {
      return (
        'type "selection" requires "options": a non-empty array of ' +
        '{"value": "...", "label": "..."}, e.g. [{"value": "draft", "label": "Draft"}].'
      );
    }
    if (options.length > MAX_SELECTION_OPTIONS) {
      return `at most ${MAX_SELECTION_OPTIONS} options are allowed`;
    }
    const seen = new Set<string>();
    for (const [index, option] of options.entries()) {
      if (
        !isPlainObject(option) ||
        typeof option.value !== 'string' ||
        option.value.trim().length === 0 ||
        typeof option.label !== 'string' ||
        option.label.trim().length === 0
      ) {
        return `options[${index}] must be {"value": "...", "label": "..."}, both non-empty`;
      }
      if (seen.has(option.value.trim())) {
        return `options[${index}] repeats the value "${option.value}"; each option value must be unique`;
      }
      seen.add(option.value.trim());
    }
  }

  return null;
}

/** The selection options as they will be sent, trimmed, preserving order. */
export function normalizeSelectionOptions(
  options: readonly SelectionOptionInput[] | undefined,
): { value: string; label: string }[] | undefined {
  if (!options) return undefined;
  return options.map((option) => ({ value: option.value.trim(), label: option.label.trim() }));
}
