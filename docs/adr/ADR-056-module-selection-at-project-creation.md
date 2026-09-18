# ADR-056: Module selection at project creation

- Status: Proposed
- Date: 18 September 2026
- Milestone: Phase 5 (connected-server estate)

Builds on ADR-037 (edition per project), ADR-039 (provisioned instance), ADR-045
(centralized version catalog and template databases), ADR-051 (standard-database
catalog).

## Context

ADR-045 made every new project arrive with **every app of its edition
installed**, cloned in seconds from a pre-built, fully-installed template
database. That was an explicit operator request at the time and remains the
default a project gets today.

The operator has now asked for the opposite capability alongside it: on Odoo
Online and Odoo.sh, a customer picks which modules to install at the moment
a project/instance is created, rather than receiving everything and removing
what is unwanted afterwards. LinkedERP wants the same choice available in the
"Create with AI" flow.

Two things already exist and point at this gap without closing it:

- `CreateProjectWithAiDto.modules` (`backend/src/modules/projects/dto/project.dto.ts`)
  already accepts an array of module names from the request.
- `project-specification.ts` already writes that array into the generated
  specification document (`modules: [...]`).

Neither reaches provisioning. `ProjectProvisioningService` and
`create-project-db.sh` know only one path: clone the full-installation
template selected by version, edition and region (ADR-045, ADR-051). The
`modules` field the caller supplies is presently decorative — it documents
intent for the AI agent's later task work, not an installation instruction.

## Decision

### 1. Module selection is a project-creation input, validated against a real catalog

The portal's Create-with-AI form gains a module-picker step. It is populated
from a new read-only endpoint, `GET /odoo-versions/:version/modules?edition=`,
which enumerates the installable modules for that version/edition by reading
`__manifest__.py` across the catalog's own addon paths (ADR-045's
`odoo_version_repositories` row) rather than from a hand-maintained list. Each
entry carries the module's technical name, its display name, and whether it is
an "application" (`application: True` in the manifest) so the picker can lead
with apps and fold in technical dependencies.

The existing `modules?: string[]` field on `CreateProjectWithAiDto` is kept as
the wire shape; it is now validated against that catalog instead of accepted
as free text — an unknown name is refused before it reaches any shell
invocation.

### 2. Two provisioning paths, selected by whether a selection was made

- **No selection (default): unchanged.** An empty or omitted `modules` array
  keeps today's behaviour exactly — clone the full-installation template
  (ADR-045/051). This is the zero-friction path and stays instant.
- **Explicit selection: install, don't clone-full.** When `modules` is
  non-empty, `create-project-db.sh` clones from a new **base-only** template
  (`cartenz_tpl_<ver>_<edition>_base`, one per version/edition, built once by
  the operator the same way the full templates are) and then runs
  `odoo-bin -i <csv modules> --without-demo=all --stop-after-init` against the
  clone — the same install step `create_project`/`create_project_enterprise`
  already run for `base` today (ADR-045 §1), generalised to an arbitrary
  module list instead of a hard-coded one.

This keeps the fast path fast and only pays install time when a customer
actually asked to choose.

### 3. The module list is sanitised before it reaches a shell

`-i` takes a comma-separated string that is otherwise built from caller
input. Before any command is assembled: every name is checked against the
enumerated catalog from step 1 (rejecting anything not a real, known module),
and independently constrained to `^[a-z][a-z0-9_]*$` as a defence-in-depth
floor. The validated list is passed as a single argument, never interpolated
into a shell string. This is the same posture `assertProvisioningInvocation`
(ADR-039) already holds for every other provisioning argument.

### 4. Selective installs are asynchronous

A full-template clone completes in seconds and today's provisioning call
returns synchronously. An install of an arbitrary module set does not have
that bound — it depends on how many modules and their dependency graph, and
can run for minutes, which is well past the safe foreground-call budget this
platform already avoids elsewhere (ADR-039's 180-second concern, noted for the
existing `-i base` step and worse for a large selection).

`ProjectProvisioningService` therefore reports `status: 'provisioning'`
immediately for the selective path and completes it as a tracked background
job, the same shape the agent task pipeline already uses for long-running
work. The portal polls project status the way it already polls task status;
no new polling mechanism is introduced.

### 5. Dependencies are resolved, not just the checked boxes

Selecting a module whose manifest `depends` are not also selected must not
silently fail the install. The picker's backend resolves the full transitive
`depends` closure of the checked modules before building the `-i` list, and
shows the caller the resolved set (so "you also get X, Y" is visible) rather
than passing only the boxes literally checked and letting Odoo's own installer
error out mid-run.

## Consequences

- The default project-creation path (no selection) is unaffected: same
  template, same instant clone, same full app set.
- A project created with an explicit module selection takes materially longer
  to provision — an install, not a copy — and needs its own base-only template
  per version/edition, which is one more artifact the operator builds and
  refreshes alongside the existing full templates (ADR-045 §3).
- The module catalog endpoint reads manifests directly off the host's addon
  paths, so it is always accurate to what is actually installable there,
  including a customer's own custom addons already registered in the catalog
  — no separate list to keep in sync.
- Provisioning gains a genuine async state for the first time on the
  project-creation path (task execution already has one); the portal's
  project-status UI needs the same "in progress" affordance it already has for
  tasks.
- The install path exercises Odoo's own dependency resolution and can fail
  the way any manual `-i` install can (a missing system package, a broken
  manifest); provisioning must surface that failure onto the project row
  rather than leaving it silently stuck in `provisioning`.

## Retirement condition

Retire the base-only-template branch if template storage/build cost becomes
prohibitive relative to how often selection is actually used; the full-install
default path is unaffected either way and would remain.

## Verification

- Unit: the sanitiser rejects a module name not present in the enumerated
  catalog and rejects any name failing `^[a-z][a-z0-9_]*$`, independently of
  the catalog check.
- Unit: dependency resolution against a manifest fixture with a chain of
  `depends` returns the full transitive closure, not just the selected names.
- Host: `GET /odoo-versions/19.0/modules?edition=enterprise` returns a list
  whose module count and application flags match `find <addons paths>
  -name __manifest__.py` read by hand.
- End-to-end, default path: creating a project with no `modules` produces the
  same result as today — instant clone, full app set, `datallowconn` etc.
  unaffected.
- End-to-end, selective path: creating a project with a small module
  selection (e.g. `['sale_management']`) produces a running instance whose
  `ir_module_module` shows exactly that module, its resolved dependencies, and
  `base` as `state='installed'` — nothing else — and whose provisioning status
  transitioned `provisioning` → `provisioned` (or `failed`, with a reason, on
  an install error) rather than blocking the request.
