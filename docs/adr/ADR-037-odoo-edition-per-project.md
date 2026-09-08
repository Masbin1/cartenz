# ADR-037: Odoo edition (Community or Enterprise) is chosen per project

- Status: Accepted
- Date: 08 September 2026
- Milestone: Phase 5 (Odoo-aware development)

Amends ADR-035 (the generated `odoo.conf`). Builds on ADR-033 (Odoo paths in the
portal) and ADR-036 (an AI project is scaffolded and runs on-premise).

## Context

A project's generated `odoo.conf` (ADR-035) always lists three addons entries:
the project's own `addons/`, the organisation's enterprise path, and the Odoo
core. That is correct for an Enterprise installation, but a Community project has
no Enterprise licence and no enterprise addons directory: putting the enterprise
path on its `addons_path` either loads modules the project is not entitled to or,
when the directory is absent, makes Odoo warn on every start.

The user asked for the distinction at creation time: *"saya mau ada 2 pilihan,
mau yang odoo community atau odoo enterprise. nah kalo community addons path nya
gak pake enterprise."* The choice is a durable property of the project — it
governs how the project runs — not a per-run flag, so it belongs on the project.

## Decision

1. **A project records its Odoo edition.** A new closed enumeration
   `ODOO_EDITIONS = ['community', 'enterprise']` and a `projects.odoo_edition`
   column hold it. The column defaults to `enterprise`, which is the behaviour
   before this change, so every existing project and every caller that does not
   send the field is unchanged.

2. **The create forms offer the choice.** Both the "connect / on-premise" form
   and the "Create with AI" form gain an edition selector, sent as `odooEdition`
   on the two create DTOs (optional; absent means `enterprise`).

3. **Community omits the enterprise path from the generated conf.** The runnable
   `odoo.conf` (ADR-035) lists the enterprise path only for an Enterprise
   project. For a Community project the addons path is the project's `addons/`
   followed by the Odoo core, with no enterprise entry. This is the whole of the
   functional difference the user asked for.

## Consequences

- A Community project starts against Community modules only; its `odoo.conf` no
  longer names an enterprise directory it is not entitled to, and Odoo does not
  warn about a missing path.
- The edition is stored, not inferred, so it is visible on the project and
  available to later decisions (for example, restricting which source the agent
  reads — deliberately out of scope here and noted as a follow-up).
- `enterprise` is the default at every layer (column, DTO, generator), so this is
  additive: existing projects behave exactly as before, and only a project
  created as Community sees the narrower path.
- This decides the addons *path* of the generated conf and, for a community
  project, also what the agent may READ: `sourcePathsFor(orgId, edition)` drops
  the portal-configured enterprise path for a community project, so a community
  project's tasks cannot read enterprise source (ADR-031). The exclusion applies
  to the portal-configured enterprise path — the identifiable one; the
  environment fallback (`ODOO_SOURCE_PATHS`) is a flat, unlabelled list and is
  left as configured, so a deployment wanting the narrower behaviour sets the
  paths in the portal rather than the environment.

## Verification

- Unit: `buildRunnableConf` with `edition: 'community'` produces an `addons_path`
  of `<base>/addons,addons` (no enterprise entry) even when an enterprise path is
  supplied; with `edition: 'enterprise'` it keeps the three-entry path.
- End-to-end (dev box): a project created as Community produces an `odoo.conf`
  whose `addons_path` has no enterprise directory; the same project created as
  Enterprise includes it. Evidence is the generated file, not the diff.
- Unit: `sourcePathsFor(orgId, 'community')` drops the configured enterprise path
  while `'enterprise'` (and the default) keep it, so a community task's agent is
  handed base-only source.
