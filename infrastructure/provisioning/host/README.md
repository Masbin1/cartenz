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

## Fallback: source-built full installation (ADR-045)

Where no standard database exists, build the source-based template as before:

    /opt/cartenz/infrastructure/provisioning/build-odoo-templates.sh 19.0 \
        /opt/odoo/odoo-server /opt/odoo/venv/bin/python /opt/odoo/enterprise

Then a new project of version 19.0 clones `cartenz_tpl_19_0_com` /
`cartenz_tpl_19_0_ent` in seconds instead of installing every module again.
