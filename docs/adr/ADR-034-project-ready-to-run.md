# ADR-034: A new project is ready to run

- Status: Accepted
- Date: 06 September 2026
- Milestone: Phase 5 (Odoo-aware development)

Amends ADR-027 (validation) and ADR-033 (project layout).

## Context

Creating a project with AI produced something that could not be worked on: the
portal answered "This project has no environments declared, so there is no branch
to work on". Four separate defects stood between creating a project and running
its code.

1. **AI projects had no environment.** `create` builds a default "Development"
   environment; `createAiProject` inserts the project row and the specification
   and stops. Every task submission then fails environment resolution (ADR-021),
   which is the warning the user saw. The two creation paths had drifted apart —
   the branch a task targets is not an optional extra.

2. **The addons path pointed at the repository root.** A validation run put the
   workspace root on `addons_path`. Under the ADR-033 layout the modules are in
   `<project>/addons/`, so Odoo scanned the directory containing `addons/` and
   found no module at all.

3. **Changed files did not map to modules.** `changedModules` treats the first
   path segment as the addon name. Under the new layout that segment is always
   the literal `addons`, so a run would attempt to install a module by that name
   and fail.

4. **The interpreter was hard-coded to `python3`.** Odoo needs an interpreter
   with its dependencies installed, which on a normal deployment is a virtualenv
   and not the system Python. There was no way to say which one to use.

Individually each is small; together they mean no project created by the platform
could ever be validated.

## Decision

1. **Both creation paths build environments.** `createAiProject` calls the same
   `buildForCreation` as `create`, inside the same transaction as the project
   row, so a project without an environment cannot exist.

2. **The addons path is the project's addons directory when there is one.**
   Validation puts `<workspace>/addons` on the path when that directory exists,
   and the workspace root otherwise — so both the ADR-033 layout and a
   conventional Odoo repository work without configuration.

3. **Module detection understands the layout.** `changedModules` skips a leading
   `addons/` segment, so `addons/vania_sales/models/x.py` maps to
   `vania_sales` rather than to `addons`.

4. **`ODOO_PYTHON` names the interpreter.** Defaulting to `python3` preserves
   current behaviour; a deployment with a virtualenv points at it directly.

## Consequences

- A project created by either path can be worked on immediately: it has a branch,
  its addons directory is on the path, and edits map to installable modules.
- Validation depends on an interpreter that can import Odoo. When it cannot, the
  run fails with that error rather than silently testing nothing — a validation
  that cannot run must not report success.
- The layout is detected rather than configured. A project whose modules sit at
  the repository root keeps working, which matters for repositories the platform
  did not create.
