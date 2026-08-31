/**
 * Secret storage contract (ADR-014).
 *
 * Every credential the platform holds passes through this interface. The
 * foundation binds EnvelopeEncryptionSecretsProvider; a Vault-backed provider
 * will be bound in its place without touching a caller.
 *
 * Two properties are deliberate:
 *
 *  1. `write` returns a reference, not the value. A caller stores the reference
 *     and cannot accidentally persist the secret alongside it.
 *  2. There is no `list` and no bulk read. A secret is read one reference at a
 *     time, by code that has a specific reason to need it, so that a future
 *     mistake cannot enumerate the store.
 */
export interface SecretReference {
  /** Opaque handle stored by the owning record. */
  readonly ref: string;
}

export interface SecretWriteRequest {
  readonly organizationId: string;
  /** Null for an organisation-scoped secret. */
  readonly projectId: string | null;
  /** Short label describing the secret's purpose, e.g. `github-token`. */
  readonly purpose: string;
  readonly value: string;
}

export interface SecretsProvider {
  /** Seals a value and returns the reference to store in its owning record. */
  write(request: SecretWriteRequest): Promise<SecretReference>;

  /**
   * Unseals a single secret. Called only from code that is about to use the
   * value against an external system. The return value must never be logged,
   * serialised into a response, or written to an audit record.
   */
  read(ref: string): Promise<string>;

  /** Removes a secret. Used when a connection is deleted. */
  destroy(ref: string): Promise<void>;

  /** True when the reference resolves, without unsealing the value. */
  exists(ref: string): Promise<boolean>;
}

export const SECRETS_PROVIDER = 'SECRETS_PROVIDER';

export class SecretNotFoundError extends Error {
  constructor(ref: string) {
    super(`No secret found for reference ${ref}`);
    this.name = 'SecretNotFoundError';
  }
}
