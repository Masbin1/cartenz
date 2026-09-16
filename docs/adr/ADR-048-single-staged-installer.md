# ADR-048: One staged installer for the whole estate, replacing three overlapping scripts

- Status: Accepted
- Date: 16 September 2026
- Milestone: Phase 5 (Odoo-aware development)

Builds on ADR-039/040 (provisioning via the operator's scripts) and ADR-045
(version catalog and template databases).

## Context

Three top-level installers had grown around one another:

- `install-server.sh` — the platform: packages, service account, database,
  build, 9router, systemd units.
- `install-vps-full.sh` — the platform plus Hermes, with its own copy of the
  helpers, its own `.env` upsert and its own wiring.
- `install-all-existing-odoo.sh` — the platform plus Odoo *adoption* on a host
  that already ran Odoo, with a third copy of the helpers and another `.env`
  upsert.

The three overlapped on the same steps, duplicated their output helpers
verbatim, and split the estate incoherently: 9router was step 7 of the base
installer, Hermes existed only in the VPS wrapper, Odoo was never installed by
anything (only adopted when present), and the ADR-045 pieces — the
provisioning scripts and the template databases — had no installer step at
all. The operator's actual estate (Odoo source, venv, roles, projects root,
sudoers rule) was assembled by hand between the three scripts and two install
guides.

The user asked for this to be cleaned up, with one script that takes a fresh
server from empty to running: Hermes, 9router, Odoo and Cartenz.

## Decision

### 1. One entry point, seven stages

`infrastructure/install/install.sh` runs the estate as ordered stages, each
its own file under `infrastructure/install/stages/`:

| Stage | What it does |
| --- | --- |
| `base` | packages, Node.js, PostgreSQL, Redis, service account |
| `odoo` | install Odoo per version, or adopt an existing checkout read-only |
| `gateway` | 9router |
| `hermes` | Hermes agent — opt-in |
| `cartenz` | platform code, `.env`, database, build, migrate, units |
| `provisioning` | sudoers rule, operator scripts, projects root, Odoo paths |
| `templates` | full-installation template databases — opt-in |

Selection is explicit: the default run is everything except the two opt-ins
(`hermes`, `templates`, both heavy), `--with` adds, `--skip` removes,
`--only` runs exactly the named stages, `--dry-run` prints the plan. A
re-run of one stage is the repair path: idempotence stays a per-step check,
exactly as before.

### 2. One copy of the shared machinery

`lib/common.sh` holds the output helpers, the dry-run wrapper and the
service-user wrappers; `lib/env.sh` holds one `.env` upsert used for both the
platform and Hermes files; `lib/preflight.sh` holds the checks and the
defaults. Stages source these; nothing is re-declared. A stage that runs a
system-changing command outside `run` is a bug, because `--dry-run` must not
lie.

### 3. One configuration file

`install.conf.example` carries every knob with its default, named after the
environment variable it sets. An operator copies it to `install.conf`, which
the installer reads — the environment still wins, so a one-off run can
override without editing the record. The file itself is deliberately not
shipped as `install.conf`: each host's values are that host's record, and
they must not ride in the repository.

### 4. Odoo is installed or adopted, decided by what is there

The `odoo` stage auto-detects: a version directory that already holds
`odoo-bin` is **adopted** (the service user joins the Odoo group, nothing
Odoo owns is touched); an empty one is **installed** (source clone for the
series, per-version venv, dependencies, read-only group access). Both paths
preserve the standing golden rule — Cartenz reads the Odoo source and never
owns it.

### 5. The old three scripts are deleted

`install-server.sh`, `install-vps-full.sh` and `install-all-existing-odoo.sh`
are removed rather than kept as deprecated wrappers: keeping them would
perpetuate four installers where the whole point is one. The install guides
and the runbook are updated to the new entry point. Nothing already
installed on a host is affected — an installed host does not run its
installer again.

## Consequences

- A fresh server is brought up with one command, and the ADR-045 pieces that
  previously had no installer step (operator scripts, sudoers rule, template
  databases) now do.
- Stage boundaries make re-runs targeted: `--only cartenz` repairs a failed
  build, `--with templates` adds templates to an estate installed without
  them.
- The installer no longer pretends Odoo is someone else's problem: the
  install path exists, and the adopt path remains for hosts that already run
  Odoo.
- The three deleted scripts are gone from the repository; their behaviour is
  preserved stage-for-stage in the new files, and the guide text that
  referred to them is rewritten.
- The installer is tested by syntax (`bash -n`), by `--help`, `--dry-run`
  and argument validation, and on a real fresh host — never by uncommitted
  local experimentation. A stage may still fail on a host the operator has
  customised; the failure names the stage, and `--only` is the re-run.

## Verification

- `install.sh --help` prints the usage without requiring root; an unknown
  stage or flag is refused with the known list; `--dry-run` prints the plan
  and changes nothing.
- `bash -n` passes on every stage and library file.
- Stage selection: default excludes `hermes` and `templates`; `--with`
  adds them; `--skip` removes by exact name; `--only` runs exactly the
  named set.
- The three removed installer names appear nowhere in the repository's
  documentation or scripts.
