/**
 * The model surface of an Odoo Online instance: what a request to create a model
 * may say, checked before anything leaves the platform (ADR-068).
 *
 * Creating a model is the one customization this mode performs that Odoo cannot
 * undo from the same tool: `ir.model` has no `unlink` in the client, and the
 * model's table is created as part of the call. The checks here are therefore the
 * narrowest ones the request can carry, and they mirror Odoo's own rules rather
 * than inventing stricter ones — a request this module accepts is one Odoo would
 * accept, and a request it refuses is one Odoo would have refused with a message
 * nobody could act on.
 *
 * Kept free of Nest and I/O so the policy is tested on its own.
 */

/**
 * A manual model's technical name must start with `x_`.
 *
 * Odoo enforces this twice (`ir.model._check_model_name` → `_check_manual_name`)
 * and separately restricts the character set (`models.check_object_name`:
 * lowercase letters, digits, underscores and dots). Both are applied here so a
 * malformed name is refused locally with a readable reason instead of travelling
 * to the instance to come back as a traceback. Dots are allowed after the prefix
 * (`x_servis.line`) because Odoo allows them; refusing one would be a rule the
 * instance does not have.
 */
const MANUAL_MODEL_NAME = /^x_[a-z0-9_]+(\.[a-z0-9_]+)*$/;

/** A model label is a human string; only its length is worth bounding. */
const MAX_LABEL_LENGTH = 200;

/** What a create-model request looks like once accepted. */
export interface CreateModelRequest {
  readonly model: string;
  readonly label: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validates an `odoo_create_model` request. Returns a reason, or null.
 *
 * The returned model name is normalized before use by `normalizeModelName`, so a
 * caller that passes `X_Servis` gets a readable refusal rather than a silently
 * lowercased name it did not ask for.
 */
export function validateCreateModel(input: unknown): string | null {
  if (!isPlainObject(input)) return 'the input must be an object';

  const model = input.model;
  if (typeof model !== 'string' || model.trim().length === 0) {
    return 'model is required: the technical name, starting with "x_", e.g. "x_servis"';
  }
  if (!MANUAL_MODEL_NAME.test(model.trim())) {
    return (
      `"${model}" is not a valid manual model name. It must start with "x_" and ` +
      'contain only lowercase letters, digits, underscores and dots, e.g. "x_servis"'
    );
  }

  const label = input.label;
  if (typeof label !== 'string' || label.trim().length === 0) {
    return 'label is required: the human name shown in the UI, e.g. "Servis"';
  }
  if (label.trim().length > MAX_LABEL_LENGTH) {
    return `label must be at most ${MAX_LABEL_LENGTH} characters`;
  }

  return null;
}

/** The technical name as it will be sent, trimmed. */
export function normalizeModelName(model: string): string {
  return model.trim();
}

/** The label as it will be sent, trimmed. */
export function normalizeModelLabel(label: string): string {
  return label.trim();
}
