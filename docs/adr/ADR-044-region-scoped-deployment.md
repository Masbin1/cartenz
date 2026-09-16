# ADR-044: One deployment, region-scoped — the organisation is gone

- Status: Accepted
- Date: 16 September 2026
- Milestone: Phase 5 (Odoo-aware development)

Builds on ADR-015 (first-party authentication) and ADR-043 (per-project access
control), whose `project_members` grant this decision now sits underneath rather
than beside. Amends ADR-023 (portal-managed model provider) and ADR-033 (Odoo
paths in the portal): both moved from an organisation-scoped setting to a
deployment-wide one; see the note added to each.

## Context

The platform was multi-tenant by organisation: `organizations` and
`organization_members` existed, every tenant-scoped table carried an
`organization_id`, and a person reached a project by belonging to the
organisation that owned it. ADR-043 then added a second, finer gate —
`project_members` — because organisation membership on its own was too coarse: it
opened every project in the organisation, not the one a person actually needed.

Once that finer gate existed, the organisation stopped doing any work the finer
gate did not already do better. It was not the billing boundary in practice —
this deployment invoices one client, LinkedERP, not a set of tenants — and it was
not the isolation boundary either, once ADR-043 could grant or refuse a single
project directly. What it still was: a column threaded through eleven tables, a
join on every scoped query, and a second, slower-changing set of roles
(owner/admin/developer/viewer) that had to be kept sensible alongside the
project-level grant that actually decided access.

The operator's own deployment plan sharpened the question: LinkedERP works
across regions — Indonesia, South Africa, India — and what a person should see
is which region's clients they work with, not which organisation record they
were added to. Region is the real-world boundary; organisation was a boundary
invented to hold a place region could fill directly.

## Decision

### 1. Region replaces the organisation as the visibility boundary

`USER_REGIONS = ['indonesia', 'south_africa', 'india']` is a closed enumeration.
Every user and every project carries a `region`, chosen at creation. A regular
user's project list is filtered to their own region, plus anything reached
through an ADR-043 grant or a project they created — the same cross-region
exception ADR-043 already made for a grant now also crosses regions. An admin
sees every region.

### 2. A flat admin flag replaces the role hierarchy

`users.is_admin` is a boolean. There is no owner/admin/developer/viewer rank
above the project level any more: `requireAdmin` checks the flag, and everything
below the flag is decided by ADR-043's grant (does this person have a row in
`project_members`, did they create the project, or are they an admin) plus the
project's own per-project `agentPermissions`. Two gates, not a hierarchy of
four ranks crossed with a grant.

### 3. Projects get one flat name space

Without an organisation to scope uniqueness, a project name is unique across the
whole deployment rather than per organisation. Fewer than a thousand clients
share one name space comfortably, and the alternative — keeping a scoping column
with nothing left to scope by — would have been complexity with no boundary
behind it.

### 4. Deployment-wide configuration stops pretending to be per-tenant

`organization_model_settings` and `organization_odoo_settings` are renamed to
`model_settings` and `odoo_settings` and lose their scoping column entirely. The
model provider chain and the Odoo version catalog were never actually a
per-organisation choice in this deployment — one operator configures one model
chain and one set of Odoo checkouts for everyone — so the column was recording a
distinction nobody made. ADR-023 and ADR-033 are amended by this: both
describe the setting as organisation-scoped, and it no longer is.

### 5. The migration is a single file, ordered so nothing can be half-dropped

`0015_regions.sql` runs as one sequence: add `region` and `is_admin`, backfill
every existing project to `indonesia` and every organisation owner or admin to
`is_admin = true`, rename and de-scope the two settings tables, drop
`organization_id` from every other table it appears on, and only then drop
`organization_members` and `organizations` themselves — last, because by that
point nothing references them and the drop cannot fail on a dependency. A
non-admin organisation member is not separately backfilled here: ADR-043's own
migration (`0014_project_access.sql`) had already given every such person a
`project_members` row, so their access survives the organisation that granted it
without this migration having to re-derive it.

## Consequences

- The tenancy vocabulary throughout the earlier chapters of this document —
  "per organisation", "the organisation is the tenancy boundary" — describes a
  boundary that no longer exists in the code. Where this document still uses
  that language elsewhere, it is describing history, not the current shape.
- `backend/src/modules/organizations/` is gone; its routes live under
  `/settings` (global, admin-gated) and the project endpoints (region- and
  grant-filtered) do the rest.
- A model provider key or an Odoo checkout path is now one setting for the whole
  deployment, not one per tenant. For a single-client-facing platform this is
  the honest shape; a future multi-tenant deployment would need the scoping
  column back, deliberately, rather than finding it already there and unused.
- `infrastructure/scripts/smoke-test.sh` was written against the organisation
  model — it registers with `organizationName`, reads `organizations.0.role`
  from the registration response, and posts `organizationId` on project
  creation. None of those fields exist any more, so the script fails outright
  rather than passing on stale assumptions. It has not been rewritten as part of
  this decision; `docs/verification-log.md` records it as broken rather than
  claiming it passes.

## Verification

- Migration: `0015_regions.sql` applied against the live database; every
  pre-existing project confirmed in `indonesia`, every prior organisation
  owner/admin confirmed `is_admin = true`, and `organizations` /
  `organization_members` confirmed absent from `\dt` afterward.
- Unit: `AuthorizationService.requireAdmin` and `requireProjectAccess` resolve
  region and the admin flag from the token without a database read;
  `assertRegionAllowed` (`projects.service.ts`) permits an admin to create in any
  region and refuses a non-admin creating outside their own.
- End-to-end: a non-admin user in one region does not see a project created in
  another region until granted access to it or the project is created by them;
  an admin sees both without a grant.
