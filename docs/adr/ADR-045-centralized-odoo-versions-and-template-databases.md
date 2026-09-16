# ADR-045: Centralized Odoo version repositories and template-database provisioning

- Status: Accepted
- Date: 16 September 2026
- Milestone: Phase 5 (Odoo-aware development)

Builds on ADR-033 (Odoo paths in the portal), ADR-036 (Create-with-AI
scaffolding), ADR-037 (edition per project) and ADR-039 (provisioning by the
operator's scripts).

## Context

Every new project points its generated `odoo.conf` at one organisation-wide
base path (ADR-033). That is one version: a deployment hosting several Odoo
series has nowhere to say which checkout serves `18.0` and which serves `19.0`,
so a project declared as one version can be generated against another's source.

Creating a project also produces an *empty* Odoo: the operator's
`create_project` scripts initialise a database with `-i base` only. Installing
"all apps" for a new customer means either a person clicking through the apps
menu, or agent time spent writing install commands — and the user asked for the
opposite:

> *"saya mau semua apps nya terinstall semua. dan saya pikir kita bikin 1 db buat
> enterprise dan 1 db buat community, tapi full installation, jadi waktu kita
> bikin project baru, dbnya bisa duplicate dari sana"*

The request has three parts, all pointing the same way:

1. **One catalog of Odoo versions.** A full source checkout per version,
   registered once, then referenced by every project of that version — no
   regenerating boilerplate per request, and no AI tokens spent producing what
   is already on disk.
2. **Full installation at project creation.** A new project's database comes
   with every app of its edition installed, not `base` only.
3. **Instant duplication.** Building that database by *copying* a prepared
   template, not by running an install, so project creation stays fast.

A schema for part 1 already exists — `odoo_version_repositories` (migration
0016) — with no code reading it. Parts 2 and 3 are purely a provisioning-side
change: PostgreSQL can clone a whole database with `CREATE DATABASE ... TEMPLATE
...` in seconds, because it copies files rather than replaying work.

## Decision

### 1. A version catalog, one row per version

`odoo_version_repositories` holds one row per Odoo series (`15.0` … `19.0`):
the base checkout root (holds `odoo-bin` and `addons/`), the enterprise addons
directory, an `is_active` flag and a description. Rows are edited in the portal
beside the organisation-wide paths (ADR-033), by an admin, and every path is
validated the same way those are: absolute and present on the host.

The row for a version is the authority for that version. The single
organisation-wide base path stays as the fallback for a project whose version
has no catalog row — an existing deployment with one checkout and no catalog
changes behaviour exactly zero.

### 2. Project creation resolves source paths through the catalog

When a project is created (either flow, ADR-036), its declared `odooVersion`
selects the active catalog row. The generated `odoo.conf` (ADR-035) then lists
that row's base (and enterprise, per edition — ADR-037) instead of the
organisation-wide paths, and the agent's read-only source paths for tasks on
the project resolve the same way. Version is already a first-class field on
the project; this makes it mean something on disk.

### 3. Template databases, full installation, one per version and edition

The operator builds the templates once per version and edition, with the
scripts in `infrastructure/provisioning/`:

- `build-odoo-templates.sh <version> <base> [enterprise]` runs
  `odoo-bin -i <every module in the addons path> --without-demo=all --stop-after-init` (Odoo 19 no longer expands `-i all`) against a scratch
  database, once for each edition, and turns the result into a template named
  `cartenz_tpl_<ver>_ent` / `cartenz_tpl_<ver>_com`. This is the one-time cost:
  an enterprise full install can take tens of minutes; after it exists, nothing
  repeats it.
- The template is then neutralised: `web.base.url` and `database.uuid` are
  regenerated at duplication time, so no two project databases carry the same
  instance identity, and the admin password is set per project by the
  duplication step, never baked into the template.

### 4. Provisioning duplicates the template instead of installing

`create_project` / `create_project_enterprise` (the operator's scripts, invoked
as in ADR-039) replace their `createdb` + `-i base` step with
`create-project-db.sh` from this repository: `CREATE DATABASE <name> TEMPLATE
<tpl> OWNER odoo`, then the neutralisation step. Template databases are marked
`datallowconn = false` when built, which PostgreSQL itself requires for a
template to be cloneable, and which also protects them from being connected to
and drifted.

The scripts need to know the version to pick the right template, so the
platform's provisioning invocation gains one optional argument:

```
sudo -n <create-script> <project-name> <port> [<version>]
```

Without a version the scripts behave exactly as before (`-i base`), so an
operator whose scripts predate this change is not broken by it.

### 5. The platform validates the extra argument like every other one

`assertProvisioningInvocation` (ADR-039) accepts the optional fourth argument
only when it matches the known Odoo series (`^\d+\.\d+$`), and the sudoers rule
is unchanged — it already names the scripts without constraining their
arguments, and the platform's own check is the gate that matters.

## Consequences

- New projects of a cataloged version are generated against the right source,
  run it, and arrive with every app of their edition installed — no install
  step, no per-request AI generation, no per-project install time.
- The catalog is deployment state: it says which versions exist on the host.
  A version with no active row falls back to the organisation-wide path, which
  keeps single-version deployments simple.
- Template building is an operator action (root, runs Odoo against real source
  trees), like provisioning itself. The scripts live in this repository; running
  them remains documented rather than performed by the platform.
- A template that exists but is stale is a real risk: it fixes the app set at
  build time. Refreshing a template is `build-odoo-templates.sh` again — cheap,
  and the platform has no opinion on how often; the operator does.
- The full-app install is edition-aware by construction: the enterprise
  template is built against base + enterprise paths, the community one against
  base only (ADR-037).

## Verification

- Unit: `resolveRunnableConfig` uses the catalog row for the project's version
  when one is active, and falls back to the organisation-wide paths when none
  is; `assertProvisioningInvocation` accepts exactly the four- or five-argument
  shapes and refuses a malformed version.
- Host: `build-odoo-templates.sh 19.0 ...` produces two databases whose
  `datallowconn` is false and whose `ir_module_module` shows every installed
  module `state='installed'`; `create-project-db.sh` clones one in seconds and
  the clone reports a fresh `database.uuid`.
- End-to-end: a project created as `19.0` / enterprise whose catalog row exists
  produces an `odoo.conf` pointing at that row's paths, and (with provisioning
  enabled and the operator's updated scripts) a running instance whose apps
  menu is full on first login.
