# ADR-043 — Per-project access control

**Status:** Accepted
**Date:** 2026-09-15

> **Amended by ADR-044**, one day later. Every "organisation" and "organisation
> role" below describes the layer this record found and worked alongside; that
> layer is now gone. `requireOrganizationMember` is replaced by a flat
> `users.is_admin` flag, and "role in the organisation" is now just "admin or
> not". The mechanism this record actually introduces — the `project_members`
> grant, the request-and-approve flow, the 403-not-404 refusal — is unchanged
> and is what ADR-044 now sits underneath.

## Context

Authorisation had one layer: organisation membership (ADR-015). `requireProjectAccess` resolved the
project, took its organisation from the row, and asked `requireOrganizationMember` whether the
caller was in it at a sufficient rank. Nothing anywhere recorded that a particular person may use a
particular project, so nothing could ask.

The effect is that being in the organisation is being in every project in it. A viewer added to look
at one project can open all of them.

This deployment runs a single organisation. An organisation-wide role is not a boundary when
everyone shares one organisation, which makes the missing layer the only one that does any work.

`projects.agentPermissions` is per-project and is not this. It governs what the agent may do inside
a project — read records, push, restart a service — not which people may open it. The two are
deliberately kept apart.

## Decision

### 1. A grant is a row, and it carries nothing else

`project_members` holds `(project_id, user_id, granted_by_user_id)`. It has no role column, no
permission set and no expiry. The row means "may open this project"; how far the person may go
inside it remains governed by their organisation role.

A per-project role would make every authorisation decision choose between two ranks for the same
person, and the product has no question that needs the answer.

### 2. Owner and admin bypass; the creator is never locked out

Enforcement sits in `requireProjectAccess`, after membership resolves. In order: `admin` and above
pass without a query; the project's `createdByUserId` passes; a matching `project_members` row
passes; everything else is refused.

The creator clause exists because a person shut out of the project they just made is a bug, and
because `projects.createdByUserId` already records who that was.

Enforcement is in the authorisation service and not at the 28 call sites that reach it. One
forgotten call site is a silent hole; the service already promises in its own documentation that no
caller composes its own permission logic.

### 3. Refused with 403, and the project stays in the list

A member sees every project in the organisation. What is withheld is access, not existence — the
model GitLab uses, and the one this product wants.

This makes the refusal `403`, unlike the organisation-level refusal directly above it in the same
service, which returns `404` so that a non-member cannot learn an organisation exists. Here the
existence is published in the list on purpose, so concealing it at the detail endpoint would conceal
nothing while leaving the "Request access" button with nothing to point at.

A locked row in the list is served without its `description`, `repositoryUrl`, `taskCount` and
`openTaskCount`. Sending them anyway would make "locked" a colour in the UI rather than a boundary.

### 4. Access can be asked for

`project_access_requests` queues an ask with an optional reason; an owner or admin approves or
rejects it. Approval writes the decision and the grant in one transaction, so there is no state where
a request reads `approved` and no grant exists.

One pending request per (project, user) is enforced by a partial unique index rather than by a
read-then-write, following ADR-029's approval dedup (`0007_approval_pending_dedup.sql`) for the same
reason: parallel requests can both see no pending row and both insert.

The request endpoints resolve the caller through `requireOrganizationMember` rather than
`requireProjectAccess`. A person who can already open the project has nothing to ask for, and a
person who cannot must still be able to ask.

The existing `approvals` table was not reused. Its `APPROVAL_ACTIONS` enumerate agent actions — push,
migration, file deletion — gated during a task. A human asking for standing access to a project is a
different thing with a different lifetime, and merging them would put two concepts in one table.

### 5. Nobody loses access on the day it ships

Migration `0014_project_access.sql` backfills a grant for every (non-admin member, existing project)
pair. `granted_by_user_id` is null on those rows, because nobody decided them and naming someone who
did not would be a false entry in the audit trail.

Projects created after the migration start with no grants.

## Consequences

Adding a person now takes two steps: a role in the organisation, and access to the projects they
need. That is the cost, and it is the point.

Owners and admins can grant themselves any project, and an owner can promote a member to admin.
Both are audited, neither is new, and both are the intended escape hatches rather than gaps.

Retired when the platform gains real multi-tenancy. Organisation membership becomes a boundary
again at that point, and this layer becomes the finer of two rather than the only one.
