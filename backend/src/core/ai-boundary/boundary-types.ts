/**
 * The AI data boundary (chapter 12, ADR-020).
 *
 * Chapter 12 permits source code, module structure, error messages, sanitised
 * logs, Odoo metadata and test results to reach a provider. It forbids database
 * dumps, customer and employee records, financial records, passwords, API keys
 * and database credentials.
 *
 * The distinction between those two lists cannot be made by inspection, because
 * the material is assembled from files nobody on the platform has read. It is
 * made here, by three filters applied in the order chapter 12 names them.
 */

export type BoundaryFindingKind =
  | 'secret'
  | 'pii'
  | 'structured_data'
  /** A refusal rather than a redaction: the material must not be sent at all. */
  | 'blocked';

export interface BoundaryFinding {
  readonly kind: BoundaryFindingKind;
  /** What matched, e.g. `github_token`, `email_address`, `sql_result_set`. */
  readonly rule: string;
  /**
   * How many times the rule matched. The matched text is never carried: a
   * finding is recorded in the audit trail, and the whole point is that the
   * material does not travel.
   */
  readonly occurrences: number;
}

export interface BoundaryResult {
  /** The material as it may be sent. Empty when `allowed` is false. */
  readonly content: string;
  readonly allowed: boolean;
  /** Present when `allowed` is false: why the material was refused. */
  readonly refusalReason?: string;
  readonly findings: readonly BoundaryFinding[];
  readonly redactionCount: number;
  /** Bytes removed, so a heavily filtered call is visible as such. */
  readonly bytesRemoved: number;
}

export interface BoundaryOptions {
  /**
   * Direction of travel. Both are filtered: a model that has read a credential
   * can repeat it, and its output reaches the action log, the event stream and a
   * browser.
   */
  readonly direction: 'to_provider' | 'from_provider';
  /**
   * Refuses rather than redacts when the material looks like customer data
   * rather than source code. On by default; a caller cannot turn it off.
   */
  readonly label: string;
}

/** Replacement text. Distinct per kind so a reader can tell what was removed. */
export const REDACTIONS = {
  secret: '[secret redacted by the LinkedERP AI data boundary]',
  pii: '[personal information redacted]',
  data: '[customer data redacted]',
} as const;

/**
 * A refusal. Thrown by the guarded provider rather than returned, because a
 * refusal must not be recoverable by a caller that ignores a return value.
 */
export class AiBoundaryRefusalError extends Error {
  constructor(
    readonly label: string,
    readonly reason: string,
    readonly findings: readonly BoundaryFinding[],
  ) {
    super(
      `The AI data boundary refused to send "${label}": ${reason}. ` +
        'Chapter 12 of the architecture forbids sending customer data to an AI provider.',
    );
    this.name = 'AiBoundaryRefusalError';
  }
}
