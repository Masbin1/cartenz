/**
 * The record surface of an Odoo Online instance: which models the agent may read
 * and write *records* on, and how much it may touch in one call.
 *
 * Odoo Online is the mode where the work often *is* the data - "create sample
 * products", "add five demo customers" - so business records are reachable here,
 * behind the project's `database_record_read` / `database_record_write`
 * permissions (both off by default). What stays unreachable, whatever the
 * permissions say, is the instance's own machinery: users, groups, access rules,
 * system parameters, server actions, mail servers. A record write there is not
 * sample data; it is a change to who can log in or what code runs.
 *
 * Kept free of Nest and I/O so the policy is tested on its own.
 */

/** Largest number of records one create or update call may touch. */
export const MAX_RECORDS_PER_WRITE = 50;

/** Largest number of records one search may return. */
export const MAX_RECORDS_PER_READ = 100;

/** Fields returned by a search that names none: enough to identify a record. */
export const DEFAULT_READ_FIELDS = ['id', 'display_name'] as const;

const MODEL_NAME = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/;

/**
 * Model prefixes that are never a record target. `ir.*` is the instance's
 * configuration and code (views, actions, rules, crons, parameters); the rest
 * are identity, access and outbound-infrastructure models.
 */
const PROTECTED_PREFIXES = [
  'ir.',
  'base.',
  'base_import.',
  'bus.',
  'auth_',
  'auth.',
  'iap.',
  'res.users',
  'res.groups',
  'res.config',
  'res.device',
  'fetchmail.',
  'mail.alias',
  'payment.provider',
  'account.online',
];

/** Whether records of this model may be read or written by the agent. */
export function recordModelRefusal(model: string): string | null {
  if (typeof model !== 'string' || !MODEL_NAME.test(model)) {
    return `"${String(model)}" is not a valid Odoo model name`;
  }
  const protectedPrefix = PROTECTED_PREFIXES.find(
    (prefix) => model === prefix.replace(/\.$/, '') || model.startsWith(prefix),
  );
  if (protectedPrefix) {
    return (
      `records of "${model}" are part of the instance's configuration, access or ` +
      'infrastructure and are never written or read as data'
    );
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Validates an `odoo_create_records` request. Returns a reason, or null. */
export function validateCreateRecords(input: unknown): string | null {
  if (!isPlainObject(input)) return 'the input must be an object';
  const refusal = recordModelRefusal(input.model as string);
  if (refusal) return refusal;

  const records = input.records;
  if (!Array.isArray(records) || records.length === 0) {
    return 'records must be a non-empty array of field/value objects';
  }
  if (records.length > MAX_RECORDS_PER_WRITE) {
    return `at most ${MAX_RECORDS_PER_WRITE} records may be created in one call`;
  }
  for (const [index, record] of records.entries()) {
    if (!isPlainObject(record) || Object.keys(record).length === 0) {
      return `records[${index}] must be a non-empty object of field values`;
    }
  }
  return null;
}

/** Validates an `odoo_update_records` request. Returns a reason, or null. */
export function validateUpdateRecords(input: unknown): string | null {
  if (!isPlainObject(input)) return 'the input must be an object';
  const refusal = recordModelRefusal(input.model as string);
  if (refusal) return refusal;

  const ids = input.ids;
  if (!Array.isArray(ids) || ids.length === 0) return 'ids must be a non-empty array';
  if (ids.length > MAX_RECORDS_PER_WRITE) {
    return `at most ${MAX_RECORDS_PER_WRITE} records may be updated in one call`;
  }
  if (!ids.every((id) => Number.isInteger(id) && (id as number) > 0)) {
    return 'ids must be positive integers';
  }
  if (!isPlainObject(input.values) || Object.keys(input.values).length === 0) {
    return 'values must be a non-empty object of field values';
  }
  return null;
}

/** Validates an `odoo_search_records` request. Returns a reason, or null. */
export function validateSearchRecords(input: unknown): string | null {
  if (!isPlainObject(input)) return 'the input must be an object';
  const refusal = recordModelRefusal(input.model as string);
  if (refusal) return refusal;

  if (input.domain !== undefined && !Array.isArray(input.domain)) {
    return 'domain must be an Odoo domain array, e.g. [["name", "ilike", "chair"]]';
  }
  if (
    input.fields !== undefined &&
    (!Array.isArray(input.fields) || !input.fields.every((f) => typeof f === 'string'))
  ) {
    return 'fields must be an array of field names';
  }
  if (
    input.limit !== undefined &&
    (!Number.isInteger(input.limit) || (input.limit as number) < 1)
  ) {
    return 'limit must be a positive integer';
  }
  return null;
}

/** The limit actually sent: the request's, capped. */
export function effectiveReadLimit(limit: unknown): number {
  return Number.isInteger(limit) && (limit as number) > 0
    ? Math.min(limit as number, MAX_RECORDS_PER_READ)
    : 20;
}
