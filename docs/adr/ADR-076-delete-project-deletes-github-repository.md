# ADR-076: Deleting a project deletes the GitHub repository it created

- Status: Accepted
- Date: 19 October 2026
- Milestone: Phase 5 (connected-server estate)

Builds on ADR-024 (project removal), ADR-041 (a created project gets a GitHub
repository), ADR-021 (push safety) and ADR-060 (verified delivery).

## Context

ADR-024 §5 said a deleted project's repository was untouched, and that was true
when it was written: the platform could not reach a remote at all, because push
was refused at the process layer. ADR-041 changed that half. A project created
here is now scaffolded on this host, given a repository under `GITHUB_OWNER`
(`BintangLinked` on this deployment) and pushed to it, so the repository is as
much a part of the project as its database and systemd unit.

What remained is the gap the operator hit: deleting a project removed the
instance, the database, the directory and the connection row, and left the
repository behind. Permanent deletion was advertised as removing "everything it
owns" while the one artifact holding the code — the only thing that survives the
host — was neither deleted nor even mentioned. Cleaning up meant remembering a
repository name and deleting it by hand, from a project row that no longer
existed to say what it was.

## Decision

### 1. Delete only what this platform created

The repository is deleted when, and only when, two facts agree:

- it is recorded as `metadata.repository` (`owner/name`) on the project's own
  `github` connection — not inferred from a URL, which may be a remote someone
  brought; and
- it was attached by this platform, marked `managedBy: 'cartenz'` when the
  connection is recorded. Connections written before the marker existed are
  treated as the platform's own unless they carry `repositoryUrl`, which only
  the Odoo.sh path records; the Odoo.sh path now writes
  `managedBy: 'odoo-sh'` explicitly; and
- its owner is the configured `GITHUB_OWNER` (case-insensitive, as GitHub treats
  it).

A project can hold a connection to a repository the operator brought: an Odoo.sh
project whose repository was made on odoo.sh (ADR-071), or a customer's own
GitHub. Deleting that because their project here was deleted would destroy
something this platform never created. Ownership and provenance, not connection,
are the boundary; everything else is reported as left in place.

### 2. The repository is deleted before anything else is destroyed, and a failure refuses the delete

The project's connection row is the only record of which repository belongs to
the project, and it cascades away with the row. So the repository is deleted
before the audit row, the sealed secrets, the workspaces, the instance and the
project row itself.

If GitHub refuses or is unreachable, the deletion fails with 409 and the project
— with its connection intact — stays deletable. The alternative, carrying on and
reporting the failure afterwards, would leave a repository nothing points at and
no way to find it again. The same reasoning that puts secrets before the row
(ADR-024) applies with more force here: a secret can be rotated, a deleted
repository cannot be recovered.

A 404 from GitHub means the repository is already absent — a retried deletion
after a partial failure must complete rather than fail on the repository the
earlier attempt removed, exactly as creation adopts an existing repository
(ADR-041).

### 3. `keepRepository` is the explicit way out

The delete body takes `keepRepository: true`, which keeps the repository and
deletes the project. The portal renders it as a checkbox, unchecked by default
because the requested behaviour is deletion. It exists because "the code should
outlive the instance" is a legitimate intent, and because it is the escape hatch
when GitHub cannot be reached and the project still has to go — an explicit
decision, not a silent omission.

### 4. The portal says which repository goes

The confirmation names the repository (`owner/name`) and states that a repository
this platform did not create is left untouched. The previous copy — "the
repository itself is untouched, this platform never pushes to it" — was written
before ADR-041 and had become false. `PROJECT_DELETED` carries the repository and
the deletion outcome in its metadata, so the audit row still says what happened
after the project row is gone.

## Consequences

- Deleting a project now has an external dependency: GitHub must be reachable
  and `GITHUB_TOKEN` must be able to administer the repository — fine-grained
  PAT with **Administration: read and write** on the owner, or a classic token
  with `delete_repo`. Without it, deletion is refused with GitHub's own message.
- Permanent deletion is more destructive than before: it now destroys the code
  as well as the instance. That is the intent and why the typed name remains,
  but the checkbox exists for the case where it is not.
- Creating and deleting are symmetric again: a project this platform creates is
  a project this platform can fully clean up.

## Verification

- Ten unit tests on the ownership/provenance boundary, the retry-safe 404, and
  the refusal that keeps the project deletable (`github-repository-removal.spec.ts`).
- Four unit tests on the client's DELETE (`github-client.spec.ts`).
- The live token was probed against GitHub: a throwaway private repository was
  created and deleted (201 then 204), and a DELETE against a nonexistent
  repository answered 404 rather than 403 — the token can administer
  repositories under `BintangLinked`.
