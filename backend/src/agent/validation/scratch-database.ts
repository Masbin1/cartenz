/**
 * The throwaway database an Odoo test run uses (ADR-027).
 *
 * The danger this exists to bound is specific. On the on-premise host this was
 * written against, the `odoo` role is a Postgres superuser and owns twelve
 * databases including `al3-prod-august`. An Odoo test run is not a read: it
 * creates a database, installs modules into it, and runs code that writes. Aimed
 * at the wrong name, by a typo or by a collision, it would write to a customer's
 * production data.
 *
 * So the name is generated rather than supplied, it carries a prefix that no
 * Odoo database would have, and a run refuses if the name already exists rather
 * than reusing it. The role that creates it is the platform's own validation
 * role, never the customer's.
 */

/**
 * Deliberately long and specific. A name that could plausibly be a real database
 * is the failure this is guarding against, so it is made implausible.
 */
export const SCRATCH_PREFIX = 'linkederp_validation_';

export class ScratchDatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScratchDatabaseError';
  }
}

/**
 * A name unique to one task attempt.
 *
 * The task reference is included so a database left behind by a killed worker can
 * be traced to the run that made it. Lowercased and stripped, because Postgres
 * folds unquoted identifiers and a name that needs quoting is a name that will
 * one day be used unquoted.
 */
export function scratchDatabaseName(taskReference: string, attempt: number): string {
  const slug = taskReference.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

  if (!slug) {
    throw new ScratchDatabaseError(
      'The task reference produced an empty database name, which would leave the name ' +
        'to Postgres to invent.',
    );
  }

  const name = `${SCRATCH_PREFIX}${slug}_${attempt}`;

  // Postgres truncates identifiers at 63 bytes, silently. Two runs whose names
  // differ only after the cut would become one database.
  if (name.length > 63) {
    throw new ScratchDatabaseError(
      `The generated name "${name}" is ${name.length} characters, and Postgres would ` +
        'truncate it at 63 - silently, so two runs could collide on one database.',
    );
  }

  return name;
}

/** True only for a name this module generated. */
export function isScratchDatabase(name: string): boolean {
  return name.startsWith(SCRATCH_PREFIX);
}

/**
 * Refuses to act on a database this module did not name.
 *
 * Called before create and again before drop. The drop is the one that matters:
 * a bug that passed a customer's database name to a drop would be unrecoverable,
 * and no amount of care at the call site is worth as much as a check here.
 */
export function assertScratchDatabase(name: string, operation: 'create' | 'drop'): void {
  if (isScratchDatabase(name)) return;

  throw new ScratchDatabaseError(
    `Refused to ${operation} "${name}": it is not a validation database. Only names ` +
      `beginning "${SCRATCH_PREFIX}" are created or dropped by validation, so a customer ` +
      'database cannot be reached by this path however it was passed in.',
  );
}
