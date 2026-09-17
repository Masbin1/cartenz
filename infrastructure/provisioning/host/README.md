# Host-adapted provisioning scripts (this deployment)

The operator's `create_project` scripts for this host, with the ADR-045 and
ADR-051 changes:

- The third argument (an Odoo version) selects the full-installation template.
- The fourth argument (a region) selects the **standard database** for that
  version, edition and region: `cartenz_tpl_<ver>_<com|ent>_<region>`. When the
  region template is missing, the scripts fall back to the ADR-045 template
  (`cartenz_tpl_<ver>_<com|ent>`) so a host without standard databases keeps
  working.
- Without a version the scripts behave exactly as before (`createdb` + `-i base`).

Host paths, taken from `/opt/cartenz/.env` (ODOO_RUNTIMES / ODOO_SOURCE_PATHS):

- Odoo source: `/opt/odoo/odoo-server`   (holds odoo-bin + addons/)
- Interpreter: `/opt/odoo/venv/bin/python`
- Enterprise addons: `/opt/odoo/enterprise`
- Projects root: `/opt/odoo/projects`
- Domain: `masbintang.space`

## Install (as root)

    install -m 755 /opt/cartenz/infrastructure/provisioning/create-project-db.sh /opt/odoo/scripts/create-project-db.sh
    install -m 755 /opt/cartenz/infrastructure/provisioning/host/create_project /opt/odoo/scripts/create_project
    install -m 755 /opt/cartenz/infrastructure/provisioning/host/create_project_enterprise /opt/odoo/scripts/create_project_enterprise

> Existing installs: the installer never overwrites a create script that already
> exists, so update these three files by hand on a host that predates ADR-051.

## Standard databases (ADR-051)

Put the standard archives in the repository's `database/` folder (see
`database/README.md`), then build the region template once per version, edition
and region:

    /opt/cartenz/infrastructure/provisioning/build-standard-template.sh 19.0 enterprise indonesia
    /opt/cartenz/infrastructure/provisioning/build-standard-template.sh 19.0 community  south-africa

The script resolves `database/linkederp-standard-<edition>-<region>-v<major>.zip`
by default, restores it into `cartenz_tpl_<ver>_<edition>_<region>`, stores the
archive's filestore for `create-project-db.sh` to copy into each clone, and seals
the template. A new project of that version, edition and region then clones it in
seconds.

## Ephemeral preview (ADR-052)

The preview script runs from the repository checkout, not from `/opt/odoo/scripts`:

- `preview-project.sh` at `/opt/cartenz/infrastructure/provisioning/preview-project.sh`
  (the platform's default `PROJECT_PREVIEW_SCRIPT`).
- Its line in the sudoers `Cmnd_Alias` (already in
  `infrastructure/provisioning/99-linkederp-provisioning`).
- The staging directory `/opt/cartenz/preview-staging`, mode 700 owned by `cartenz`
  (the installer creates it; create it by hand otherwise).

It needs the Odoo runtimes under `/opt/odoo/versions/<ver>/` (with a matching
`venv<major>`), `python3`, `openssl`, and the standard template databases above.
The script builds a preview by cloning the task's branch, applying its retained
patch, cloning the version/edition/region template, updating the changed modules
and starting a temporary systemd unit. `PROJECT_PROVISIONING_ENABLED` must be true,
because the preview shares the same `sudo` grant.

## Fallback: source-built full installation (ADR-045)

Where no standard database exists, build the source-based template as before:

    /opt/cartenz/infrastructure/provisioning/build-odoo-templates.sh 19.0 \
        /opt/odoo/odoo-server /opt/odoo/venv/bin/python /opt/odoo/enterprise

Then a new project of version 19.0 clones `cartenz_tpl_19_0_com` /
`cartenz_tpl_19_0_ent` in seconds instead of installing every module again.

## Per-client backups (ADR-054)

`infrastructure/provisioning/backup-project.sh` snapshots one project's estate
(database, filestore, addons bundle) under `/opt/odoo/backups/<project>/`, and
`restore-project.sh` restores it. It runs from the repository checkout, like the
preview:

- Add its path to the sudoers `Cmnd_Alias` (already in
  `infrastructure/provisioning/99-linkederp-provisioning` as the seventh entry).
- `restore-project.sh` is deliberately NOT in the sudoers rule: an operator runs
  it directly as root, so custody of the backup and custody of the platform stay
  separable.

**Install both together with the restart.** With `PROJECT_BACKUP_SCRIPT`
defaulted (and provisioning on), every staging push takes a backup first; a push
whose backup fails does not proceed. If the sudoers entry is missing while the
platform is already running the backup-capable code, a staging push fails with
`sudo: a password is required` - install the rule, then restart `cartenz-api`
and `cartenz-worker`, in that order.

Try it once by hand before trusting the automatic path:

    /opt/cartenz/infrastructure/provisioning/backup-project.sh <project>
    /opt/cartenz/infrastructure/provisioning/restore-project.sh <project> <id>   # prints a plan
    /opt/cartenz/infrastructure/provisioning/restore-project.sh <project> <id> --yes

## Monitoring (register item 3)

`infrastructure/scripts/estate-monitor.sh` checks the platform units, every
`odoo-*` unit, disk headroom, the certbot timer and log volume; exit 0 healthy,
1 unhealthy. It needs no root. Wire it to cron/a systemd timer yourself; the
root-only pieces (unattended-upgrades, alert delivery) are listed in the
runbook: `docs/architecture/client-estate-and-server-architecture.md` 4.4.
