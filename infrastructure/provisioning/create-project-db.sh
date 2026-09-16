#!/usr/bin/env bash
set -Eeuo pipefail

# ============================================================
# LinkedERP - create a project database from a template (ADR-045)
# ============================================================
#
# The database step of project provisioning. Replaces the `createdb` +
# `odoo-bin -i base` pair in the operator's create_project /
# create_project_enterprise scripts with an instant duplication of the
# full-installation template built by build-odoo-templates.sh.
#
#   create_project:          create-project-db.sh <name> community <version> [url]
#   create_project_enterprise: create-project-db.sh <name> enterprise <version> [url]
#
# The duplication itself is PostgreSQL's: CREATE DATABASE ... TEMPLATE copies
# the template's files, so it takes seconds however many modules the template
# holds.
#
# After duplication the clone is neutralised so no two project databases share
# an instance identity:
#   - database.uuid     regenerated (ir_config_parameter key "database.uuid")
#   - web.base.url      set to the project's own URL, when one is given
#
# The Odoo filestore is keyed by database name, so a clone starts with an empty
# filestore — correct for a fresh customer. The admin user's login password is
# per-project concern of the calling script, as is the Odoo master password in
# the project's odoo.conf; neither is stored in the template.
#
# Usage:
#   create-project-db.sh <project_name> <community|enterprise> <version> [url]
#
# Example:
#   create-project-db.sh dodolbintangmas enterprise 19.0 \
#     https://dodolbintangmas.example.com
#
# Requirements:
#   - run as root
#   - the matching template exists (build-odoo-templates.sh was run for
#     <version>; if not, this script says so and exits non-zero rather than
#     falling back to an empty database)
# ============================================================

usage() {
    echo
    echo "Usage:"
    echo "  create-project-db.sh <project_name> <community|enterprise> <version> [url]"
    echo
    echo "Example:"
    echo "  create-project-db.sh dodolbintangmas enterprise 19.0 \\"
    echo "    https://dodolbintangmas.example.com"
    echo
    exit 1
}

if [[ "$EUID" -ne 0 ]]; then
    echo "ERROR: This script must be run as root." >&2
    exit 1
fi

if [[ $# -lt 3 || $# -gt 4 ]]; then
    usage
fi

PROJECT_NAME="$1"
EDITION="$2"
VERSION="$3"
URL="${4:-}"

if [[ ! "$PROJECT_NAME" =~ ^[a-z0-9][a-z0-9_-]{1,30}$ ]]; then
    echo "ERROR: Invalid project name." >&2
    exit 1
fi

if [[ "$EDITION" != "community" && "$EDITION" != "enterprise" ]]; then
    echo "ERROR: edition must be 'community' or 'enterprise', got '${EDITION}'." >&2
    exit 1
fi

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+$ ]]; then
    echo "ERROR: Invalid version '${VERSION}'. Expected something like 19.0." >&2
    exit 1
fi

VER_TAG="${VERSION/./_}"
TEMPLATE="cartenz_tpl_${VER_TAG}_${EDITION}"

if ! sudo -u postgres psql -tAc \
    "SELECT 1 FROM pg_database WHERE datname = '${TEMPLATE}' AND datistemplate" | grep -q 1; then
    echo "ERROR: the template database '${TEMPLATE}' does not exist (or is not a" >&2
    echo "template). Build it first:" >&2
    echo "  infrastructure/provisioning/build-odoo-templates.sh ${VERSION} \\" >&2
    echo "    <base_path> <python> [enterprise_path]" >&2
    exit 1
fi

# Duplicate. This is the whole trick: files are copied, not replayed.
sudo -u postgres createdb -O odoo -T "$TEMPLATE" "$PROJECT_NAME"

# The clone — unlike the sealed template it was copied from — must accept
# connections: templates are built with datallowconn = false.
sudo -u postgres psql -v ON_ERROR_STOP=1 \
    -c "UPDATE pg_database SET datallowconn = true WHERE datname = '${PROJECT_NAME}';"

# Neutralise the clone's identity. gen_random_uuid() is built into PostgreSQL
# 13+; the UPDATE is guarded by a WHERE so a future Odoo that stores the UUID
# elsewhere cannot make this fail the whole provisioning.
sudo -u postgres psql -v ON_ERROR_STOP=1 -d "$PROJECT_NAME" \
    -c "UPDATE ir_config_parameter SET value = gen_random_uuid() WHERE key = 'database.uuid';"

if [[ -n "$URL" ]]; then
    if [[ ! "$URL" =~ ^https?://[a-z0-9.-]+$ ]]; then
        echo "ERROR: invalid URL '${URL}'." >&2
        exit 1
    fi
    sudo -u postgres psql -v ON_ERROR_STOP=1 -d "$PROJECT_NAME" \
        -c "UPDATE ir_config_parameter SET value = '${URL}' WHERE key = 'web.base.url';"
fi

echo "OK: database '${PROJECT_NAME}' created from '${TEMPLATE}' (all modules installed)."
