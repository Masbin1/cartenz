# ADR-033: Odoo paths in the portal, and an addons directory per project

- Status: Accepted
- Date: 06 September 2026
- Milestone: Phase 5 (Odoo-aware development)

Amends ADR-031 (configuration surface) and ADR-032 (what is scaffolded).

## Context

Two things came out of using ADR-031 and ADR-032.

The Odoo source paths were environment variables. They are a deployment fact
that an operator sets once and then has to change through a file and a restart —
but they belong with the other things a person configures about their Odoo
estate, next to the model providers in the portal (ADR-023), where they can be
seen, checked and corrected without shell access.

The scaffold created a module. That was one guess too many: what a project needs
on day one is somewhere to put addons, not an addon. A module scaffolded before
anyone has described the work carries a name and a manifest that the first real
task usually has to rename or rewrite. The important property is not the module
— it is that the writable directory is separate from the read-only source, so
`base` and `enterprise` cannot be edited.

## Decision

1. **Odoo paths are organisation settings.** A new table
   `organization_odoo_settings` holds `base_path`, `enterprise_path` and
   `projects_root`, edited at `GET/PUT /organizations/:id/odoo-settings` and in
   the portal beside the AI providers. Paths must be absolute and must exist on
   the host; the endpoint reports which ones do, because a path that is merely
   stored is a task-time failure waiting to happen.

2. **The environment remains the fallback, not the authority.** With no row for
   an organisation, the platform uses `ODOO_SOURCE_PATHS` and the derivation in
   ADR-031. An existing deployment therefore keeps working, and a deployment that
   configures the portal stops depending on its `.env`.

3. **A project gets an addons directory, not a module.**
   `<projects_root>/<project_name>/addons/` is created empty, with the git
   repository at `<projects_root>/<project_name>/`. The agent creates modules
   inside `addons/` when a task asks for one — with a name that comes from the
   work rather than from the project.

4. **The addons directory is the only writable Odoo path.** Base and enterprise
   stay read-only roots (ADR-031), refused by `assertNotReadOnlyPath` on every
   write. The separation is the point of the layout: a task can read all of Odoo
   and write only into the project's own addons directory.

5. **`.gitkeep` marks the empty directory.** Git does not track directories, and
   a scaffold whose only artefact vanished on clone would be confusing. The
   repository therefore has one commit containing `.gitignore` and
   `addons/.gitkeep`.

## Consequences

- Odoo paths are visible and correctable in the portal, and wrong ones are
  reported at the moment they are entered rather than at the first task.
- A new project starts with an empty, writable addons directory: the first task
  decides what the first module is called, which is where that decision belongs.
- Settings are per organisation. On a deployment serving one organisation this is
  indistinguishable from a global setting; on one serving several, each can point
  at its own Odoo estate.
- The paths are not secrets and are stored in plain columns. They are filesystem
  locations, and treating them as credentials would mean they could not be
  displayed — which is the point of moving them into the portal.
