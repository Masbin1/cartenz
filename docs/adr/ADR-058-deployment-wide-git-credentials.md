# ADR-058: Git credentials are registered once, at deployment scope

- Status: Accepted
- Date: 22 September 2026
- Milestone: Phase 5 (connected-server estate)

Builds on ADR-014 (secrets provider) and ADR-021 (push safety and SSH remotes).
Extended by ADR-059 (a project chooses its own transport and credential).

Written after the fact: the decision shipped in commit `2b1e88c`, and this record is
reconstructed from that commit and `backend/drizzle/0022_git_credentials.sql`.

## Context

A git credential could only live on a project connection. An operator connecting
private repositories had to paste the same SSH key into every project-creation form,
and a key that is retyped is a key that is pasted wrong: the flattened-newline failure
(`error in libcrypto`) reached several forms before it was understood.

## Decision

1. A new table, `git_credentials`, holds credentials registered once for the whole
   deployment. The value is not stored there: `secret_ref` points into
   `secret_records`, sealed under the global data key through the `SecretsProvider`,
   the same mechanism `project_connections` already uses.
2. `hosts` limits which remotes a credential may be presented to (empty means any).
3. At most one credential is the default. A partial unique index on `is_default`
   enforces this, so two admins setting it at once cannot both win.
4. When a project connection carries no inline secret, branch listing and connection
   creation use the registered default (or a chosen `credentialId`).
5. The Settings page lists, tests, edits, removes and sets the default credential. The
   project-creation form offers the registered credentials and shows the default by its
   label.
6. No endpoint logs or returns a secret. Rotation updates the same `secret_ref`, and
   the SSH-key newline repair is applied server-side before the key is stored.

## Consequences

- A project can be connected without pasting a key into it.
- Which credential a push presents now depends on more than one place. ADR-059 sets
  the order in which they are consulted.

## Verification

- `backend/src/modules/settings/git-credentials.spec.ts`
