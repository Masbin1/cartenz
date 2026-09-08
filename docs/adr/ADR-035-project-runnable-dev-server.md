# ADR-035: A scaffolded project runs as a local dev server, without Docker

- Status: Accepted
- Date: 08 September 2026
- Milestone: Phase 5 (Odoo-aware development)

Amends ADR-032 (scaffolding) and ADR-033 (project layout). Complements ADR-034
(a created project is validatable) and ADR-012 (Cartenz itself runs without
Docker).

## Context

ADR-034 made a created project *validatable*: a task can install and test its
modules in a throwaway scratch database. That validation conf is generated for
one run and deleted afterwards (`odoo-validation-runner.ts`), and it runs with
`--stop-after-init`, so it never opens a port. It is a CI harness, not a server.

What a developer holds after `POST /projects { scaffold: true }` is therefore a
git repository with an empty `addons/` and nothing to start. To actually see the
project in a browser the developer had to hand-write an `odoo.conf`, work out the
three addons-path entries, and remember which interpreter can import Odoo. The
platform already knows all three — the Odoo base and enterprise paths (ADR-033)
and the interpreter (`ODOO_PYTHON`, ADR-034) — so making the developer rediscover
them is avoidable friction. It also invited the wrong mental model: that a
project needs Docker to run, when nothing in the created project uses Docker and
ADR-012 rules it out for the platform too.

The expectation, stated plainly by the user: *"kan virtual env nya udah ada …
odoo bin nya udah ada … ya harusnya tinggal running aja, bikin odoo.conf per
projectnya."*

## Decision

Scaffolding writes two extra files into a new on-premise project, committed with
the rest of the scaffold, so a freshly created (or freshly cloned) project starts
with one command and no Docker.

1. **`odoo.conf`** — a runnable server configuration, distinct from the ADR-027
   validation conf. Its `addons_path` is, in order:
   - `<project>/addons` — the project's own writable modules;
   - the enterprise path, when configured;
   - `<base>/addons` — the Odoo core modules, where `<base>` is the repo root
     that holds `odoo-bin` (ADR-033).
   It binds `http_interface = 127.0.0.1`, sets `db_name` to the project's
   directory name, and carries no password.

2. **`run.sh`** — an executable launcher that runs `<base>/odoo-bin` with the
   configured interpreter and this conf, forwarding any extra arguments
   (`./run.sh -i base`, `./run.sh -u vania_sales --dev=xml`). It reads
   `PGPASSWORD` from the environment, defaulting to the dev role.

3. **Best-effort, never fatal.** The two files are added only when the base path
   can be resolved and actually holds `odoo-bin`. When it cannot — an
   environment-only deployment whose base/enterprise split is unknown, or a
   projects root without a matching Odoo source — the rest of the scaffold is
   unchanged and creation still succeeds. A missing launcher is an inconvenience;
   a failed project creation is not.

The generated files are the developer's, not the platform's: unlike the
validation conf they persist, they are committed, and the developer may edit
them. The header says so and says they are machine-specific.

## Consequences

- A created project runs with `./run.sh` (first run `./run.sh -i base` to
  initialise its database), no Docker and no hand-written configuration.
- The conf holds absolute, machine-specific paths. A clone onto a different host
  with a different Odoo location must regenerate or edit them; the header states
  this, and re-scaffolding is not offered because the developer now owns the file.
- The password is not committed. `run.sh` takes it from `PGPASSWORD`, so the
  committed files carry no credential.
- Validation (ADR-027) is untouched: it keeps generating its own ephemeral conf
  with `--stop-after-init` against a scratch database. The two confs never share
  a file — a server conf pointed at the live database must not be what a test run
  uses, and a test conf must not be what a developer starts.

## Verification

- Unit: `buildScaffoldFiles` with a runnable config emits `odoo.conf` and an
  executable `run.sh` whose `addons_path` lists project, enterprise and core in
  that order and whose launcher names the configured interpreter and `odoo-bin`;
  without a runnable config it still emits exactly the three ADR-032 files.
- End-to-end (dev box): a scaffolded project's `./run.sh -i base --stop-after-init`
  installs against a real database, and `./run.sh` then serves HTTP on the
  configured port — quoted from Odoo's own startup log, not inferred from the diff
  (per ADR-034's lesson that `--stop-after-init` exits 0 even when it did nothing).
