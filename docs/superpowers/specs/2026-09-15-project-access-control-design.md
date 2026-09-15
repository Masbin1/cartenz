# Per-project access control — design

**Status:** Draft · **Date:** 2026-09-15 · **Topic:** A project a member can see but cannot open, an owner panel that grants access, and a way to ask for it

## Context

Authorisation today has one layer: organisation membership. `ORGANIZATION_ROLES`
(`owner`, `admin`, `developer`, `viewer`) with `ROLE_RANK` decides how deep a
member may go, and `AuthorizationService` is the single place that decides it
(ADR-015). `requireProjectAccess` looks a project up, reads its organisation from
the row, and hands off to `requireOrganizationMember`.

The consequence is that membership of the organisation is membership of every
project in it. A viewer added to see one project can open all of them. There is
no row anywhere that says "this person may use this project", and so no question
the code could ask.

This deployment runs a single organisation — LinkedERP — which makes the missing
layer the only one that matters. An org-wide role is not a boundary when
everybody is in the same org.

Three things are already right and are not being replaced:

1. **One decision point.** 28 call sites reach authorisation through
   `requireProjectAccess`. Enforcement belongs there; adding it per caller would
   mean one forgotten caller is a silent hole.
2. **`projects.agentPermissions`.** Per-project, but it governs what the *agent*
   may do (read records, push, restart). Unrelated to which *humans* may open the
   project. It is not extended here.
3. **`organization_members` and its panel.** `members-panel.tsx` manages who is
   in the organisation and at what rank. That stays as it is; this design adds a
   second, narrower question underneath it.

## Product decisions

Settled before design, and not revisited below:

1. **Visible but locked.** Every project in the organisation stays in the list
   for every member. Access is what is withheld, not existence — the GitLab
   model, and the reason the refusal is `403` rather than `404`.
2. **Owner and admin bypass.** A member at `admin` or above reaches every project
   without a grant. `developer` and `viewer` reach only what they were granted.
3. **A grant carries no role.** A row means "may open this project". How far the
   person may go inside it stays governed by their organisation role. One source
   of truth for depth.
4. **Requests are queued and decided.** A locked project offers "Request access";
   an owner or admin approves or rejects from a queue.
5. **Nobody loses access on the day this ships.** The migration backfills a grant
   for every existing (non-admin member, existing project) pair. New projects
   start closed.

## Architecture

### Data

Two tables in `backend/src/core/database/schema.ts`.

**`project_members`** — the grant.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid pk | |
| `project_id` | uuid not null | → `projects.id`, `on delete cascade` |
| `user_id` | uuid not null | → `users.id`, `on delete cascade` |
| `granted_by_user_id` | uuid null | → `users.id`, `on delete set null` — who decided, kept after they leave |
| `created_at` / `updated_at` | timestamptz | via the shared `timestamps` helper |

Unique on `(project_id, user_id)`; indexed on `user_id`, because the list view
asks "every project this user may open" on every page load.

The table has no `role`, `permissions` or `expires_at` column. Decision 3 is the
reason for the first two; nothing in the product asks for the third yet.

**`project_access_requests`** — the ask.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid pk | |
| `project_id` | uuid not null | → `projects.id`, cascade |
| `user_id` | uuid not null | → `users.id`, cascade |
| `reason` | text null | free text from the requester, optional |
| `status` | text not null | `pending` \| `approved` \| `rejected` \| `cancelled` |
| `decided_by_user_id` | uuid null | → `users.id`, set null |
| `decided_at` | timestamptz null | |
| `decision_note` | text null | shown back to the requester |
| `created_at` / `updated_at` | timestamptz | |

One pending request per (project, user), enforced by a partial unique index
rather than a read-then-write:

```sql
CREATE UNIQUE INDEX "project_access_requests_pending_unique"
  ON "project_access_requests" ("project_id", "user_id")
  WHERE "status" = 'pending';
```

This follows `0007_approval_pending_dedup.sql`, for the same reason it was
written: two parallel requests can both read no pending row and both insert, and
the duplicate then sits in the queue forever. Making it a fact of the schema is
cheaper than making it a fact of a transaction.

A decided request is kept, not deleted. "Has this been asked before, and what was
said" is the question a queue exists to answer.

The status values live in `src/core/enums.ts` as `PROJECT_ACCESS_REQUEST_STATUSES`,
next to the other closed enumerations.

### Enforcement

In `requireProjectAccess`, after `requireOrganizationMember` has returned a
membership and before the context is built. Four checks, in order, first match
wins:

1. `ROLE_RANK[membership.role] >= ROLE_RANK.admin` → allowed. No query runs.
2. `project.createdByUserId === user.userId` → allowed. A person locked out of a
   project they created is a bug wearing a feature's clothes.
3. A row in `project_members` for `(projectId, userId)` → allowed.
4. Otherwise → `ForbiddenException`, recorded through the existing
   `recordDenial` with reason `no grant for this project`.

`requireProjectAccess` selects `createdByUserId` alongside the columns it already
reads, which check 2 needs and which it does not fetch today. `ProjectContext`
gains `hasProjectGrant: boolean` so a caller that wants to render differently
can, without asking again.

`403` and not `404`, deliberately, and deliberately unlike the organisation case
above it — which returns `NotFound` so that a non-member cannot discover an
organisation exists. Here the project's existence is published in the list on
purpose. Hiding it at the detail endpoint would conceal nothing and would leave
the "Request access" button with nothing to point at.

The two escalation paths that exist today are unchanged and are worth stating so
that they are not mistaken for holes: an owner or admin may grant themselves
access to anything (they already bypass), and an owner may promote a member to
admin (which bypasses). Both are audited. Neither is new.

### Reading the list

`ProjectsService.list` keeps returning every project in the organisation. It gains
one query — the caller's grants, read once as a `Set<projectId>`, not once per row
— and each row gains:

- `hasAccess: boolean` — decision 2 and the enforcement order above, applied per row.
- `accessRequestStatus: 'pending' | 'rejected' | null` — what the button should say.

For a row where `hasAccess` is false, four fields are returned as `null`:
`description`, `repositoryUrl`, `taskCount`, `openTaskCount`. Name, project type,
Odoo version, archived state and timestamps stay. If the repository URL and the
task counts were sent anyway, "locked" would be a colour in the UI and not a
boundary — the data would already be in the browser.

`ProjectSummary` in `frontend/lib/types.ts` changes to match: the four fields
become nullable, and the two new fields are added.

### API

A new module, `backend/src/modules/project-access/`, with its own controller,
service and module file. Not folded into `projects`, which is already a large
service with a distinct job.

| Method | Path | Minimum role |
| --- | --- | --- |
| `GET` | `/projects/:projectId/members` | `admin` |
| `POST` | `/projects/:projectId/members` | `admin` — body `{ userId }` |
| `DELETE` | `/projects/:projectId/members/:userId` | `admin` |
| `POST` | `/projects/:projectId/access-requests` | any member — body `{ reason? }` |
| `GET` | `/organizations/:organizationId/access-requests` | `admin` — pending, across projects |
| `PATCH` | `/projects/:projectId/access-requests/:requestId` | `admin` — `{ decision, note? }` |

`GET /projects/:projectId/members` returns every organisation member with a
`hasAccess` flag and a note of whether it comes from a grant or from their rank,
rather than only the granted rows. The panel's question is "who can open this",
and an admin who is missing from a list of grants but can open the project anyway
would read as a bug.

The request endpoints are the exception to the enforcement rule: they resolve the
caller through `requireOrganizationMember`, not `requireProjectAccess`. A person
who could already open the project has nothing to ask for; a person who could not
must still be able to ask. They do verify the project belongs to an organisation
the caller is a member of, so a request cannot be aimed at a stranger's project.

Approving writes the decision and the grant in one transaction. Two statements
would allow a request marked `approved` whose grant never landed, which nobody
would notice until the requester said so.

Four audit events in `audit-events.ts`: `PROJECT_ACCESS_GRANTED`,
`PROJECT_ACCESS_REVOKED`, `PROJECT_ACCESS_REQUESTED`, `PROJECT_ACCESS_DECIDED`.

### Portal

**Project list** (`app/projects/page.tsx`) — a locked card keeps its position and
its name, dimmed, with a padlock and no `<Link>` wrapper. It is not a link that
refuses; it is not a link. Where the task counts would be, a **Request access**
button opens a small dialog for an optional reason. With a pending request the
button is replaced by "Awaiting approval", disabled. A rejected request shows the
note and allows asking again.

**Project access panel** — a new panel on
`app/projects/[projectId]/settings/page.tsx`, rendered only for `admin` and
above. The settings page stacks panels rather than using tabs, so this follows
that. Each organisation member is a row with a toggle; members who bypass by rank
are shown with a "by role" label and no toggle, because switching it off would do
nothing.

**Request queue** — a panel on `/settings`, beside `MembersPanel`: requester,
project, reason, age, Approve / Reject. One list across all projects, because the
person deciding opens this page to ask "is anyone waiting", not to audit a
particular project.

Both panels follow `members-panel.tsx`: the server owns every rule, the client
renders the refusal and keeps the obvious foot-guns out of reach.

**Not built:** email or realtime notification of a new request. A count badge on
the queue panel is the whole mechanism. One organisation, few people, and a
request that waits an hour costs nothing. Add it when a request is observed
getting stuck.

### Migration

`0014_project_access.sql` — the two tables, their indexes, and a backfill:

```sql
INSERT INTO project_members (project_id, user_id)
SELECT p.id, m.user_id
  FROM projects p
  JOIN organization_members m ON m.organization_id = p.organization_id
 WHERE m.role NOT IN ('owner', 'admin')
ON CONFLICT DO NOTHING;
```

`granted_by_user_id` is left null for backfilled rows: nobody decided them, and
recording a person who did not would be a lie in the audit trail. Owners and
admins are excluded because they bypass — a row for them would be dead weight that
implies a revoke would work.

After this runs, every member keeps exactly the access they had. Projects created
afterwards start with no grants.

## Testing

Three new `.spec.ts` files, following the existing ones in their directories
(`agent-permissions.spec.ts`, `project-deletion.spec.ts`). None of the three
exists today.

`src/core/authz/authorization.service.spec.ts` — one test per branch of the
enforcement order: admin bypasses without a grant; the creator reaches their own
project without a grant; a granted developer is allowed; an ungranted developer
is refused with `403` and a denial is recorded.

`src/modules/project-access/project-access.service.spec.ts` — approving writes
both the decision and the grant; a second pending request for the same pair is
refused by the index; a `developer` calling the grant endpoints is refused.

`src/modules/projects/project-access-list.spec.ts` — the list returns locked
projects with `hasAccess: false` and the four sensitive fields null.

## Consequences

Organisation role and project grant become two questions instead of one. The cost
is a second thing to configure when a person joins; the benefit is the boundary
the product needs, and the reason a single-organisation deployment is viable at
all.

Retired when the platform grows real multi-tenancy, at which point organisation
membership becomes a boundary again and this layer becomes the finer of two —
still useful, but no longer the only thing standing between a member and every
project.
