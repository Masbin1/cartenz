# Host-adapted provisioning scripts (this deployment)

The operator's `create_project` scripts for this host, with the ADR-045 change:
when the third argument (an Odoo version) is given, the project database is
duplicated from the sealed full-installation template built by
`build-odoo-templates.sh`; without it the scripts behave exactly as before
(`createdb` + `-i base`).

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

## Build the template databases once (as root, slow for enterprise)

    /opt/cartenz/infrastructure/provisioning/build-odoo-templates.sh 19.0 \
        /opt/odoo/odoo-server /opt/odoo/venv/bin/python /opt/odoo/enterprise

Then a new project of version 19.0 clones `cartenz_tpl_19_0_com` /
`cartenz_tpl_19_0_ent` in seconds instead of installing every module again.
