# ADR-014 — Secrets provider abstraction, with Vault deferred

**Status:** Accepted · **Date:** 27 August 2026 · **Milestone:** Phase 1

## Context

ADR-08 of the approved selection record adopts HashiCorp Vault as the self-hostable secret manager,
with a unique key per project and with the primary database holding only references. Chapter 12 of
the Technical Architecture adds that encryption keys are never hardcoded and that the compromise of
one project must not expose another.

Operating a Vault deployment is out of scope for the foundation milestone. The requirements it serves
are not: project connections must be able to hold Git credentials from the first milestone, and the
shape of that storage determines whether the Vault substitution is later a configuration change or a
data migration.

## Decision

All credential handling passes through the SecretsProvider interface in
`backend/src/core/secrets/`. Nothing outside that directory holds a plaintext credential.

The foundation binds EnvelopeEncryptionSecretsProvider, which implements the same key custody model
that Vault will provide:

- A per-project data key is generated on first use and is itself encrypted under a root key supplied
  only as the SECRETS_ROOT_KEY environment variable. The root key has no default and no fallback:
  the API refuses to start without it.
- Secret material is encrypted with AES-256-GCM under the project data key, so a compromise of one
  data key does not expose another project.
- The `project_connections` table holds a secret reference and never the secret. Ciphertext is held
  in a separate `secret_records` table, which is the only table a future migration to Vault must
  drain.
- No secret read path is exposed through the HTTP API. Secret values are never serialised into a
  response, an event, a log line or an audit record.

## Consequences

The key-custody requirements of chapter 12 are met from the first milestone, and the migration to
Vault is a provider swap plus a drain of one table. The cost is that the root key is held in the
process environment rather than in a key-management service, which is weaker than Vault against host
compromise and is accepted only for the pre-production milestones.

## Retirement condition

Retired when VaultSecretsProvider is bound, the root key is held in a key-management service, and
`secret_records` has been drained. Production must not run on the envelope provider.
