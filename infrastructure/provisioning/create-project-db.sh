#!/usr/bin/env bash
set -Eeuo pipefail

# ============================================================
# LinkedERP - create a project database from a template (ADR-045, ADR-051)
# ============================================================
#
# The database step of project provisioning. Replaces the `createdb` +
# `odoo-bin -i base` pair in the operator's create_project /
# create_project_enterprise scripts with an instant duplication of the
# full-installation template.
#
#   create_project:            create-project-db.sh <name> community <version> [url] [region]
#   create_project_enterprise: create-project-db.sh <name> enterprise <version> [url] [region]
#
# Template selection (ADR-051):
#
#   1. If a region is given and `cartenz_tpl_<ver>_<edition>_<region>` exists, it
#      is used — the standard database for that version, edition and region.
#   2. Otherwise, `cartenz_tpl_<ver>_<edition>` is used (the source-built
#      full-installation template of ADR-045), so a host that never built a
#      standard database keeps working.
#
# The region is accepted as `indonesia`, `south-africa` or `india`; a hyphen is
# normalised to an underscore for the template name, so `south-africa` and
# `south_africa` select the same template.
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
# The Odoo filestore is keyed by database name and is NOT copied by
# CREATE DATABASE, so a clone would start with an empty one. If the template's
# filestore was stored by build-standard-template.sh, it is copied into the
# project's data dir here; otherwise the clone starts empty, which is correct
# for a fresh customer. The admin user's login password is a per-project concern
# of the calling script, as is the Odoo master password in the project's
# odoo.conf; neither is stored in the template.
#
# Usage:
#   create-project-db.sh <project_name> <community|enterprise> <version> [url] [region]
#
# Example:
#   create-project-db.sh dodolbintangmas enterprise 19.0 \
#     https://dodolbintangmas.example.com indonesia
#
# Requirements:
#   - run as root
#   - the matching template exists (build-standard-template.sh, or
#     build-odoo-templates.sh for a source-built full installation; if not, this
#     script says so and exits non-zero rather than falling back to an empty
#     database)
# ============================================================

# --- Host configuration (adapt if your layout differs) -----------------
PROJECTS_DIR="${PROJECTS_DIR:-/opt/odoo/projects}"
TEMPLATE_FILESTORE_DIR="${TEMPLATE_FILESTORE_DIR:-/opt/odoo/templates/filestore}"
ODOO_USER="${ODOO_USER:-odoo}"
# ----------------------------------------------------------------------

usage() {
    echo
    echo "Usage:"
    echo "  create-project-db.sh <project_name> <community|enterprise> <version> [url] [region]"
    echo
    echo "Example:"
    echo "  create-project-db.sh dodolbintangmas enterprise 19.0 \\"
    echo "    https://dodolbintangmas.example.com indonesia"
    echo
    exit 1
}

if [[ "$EUID" -ne 0 ]]; then
    echo "ERROR: This script must be run as root." >&2
    exit 1
fi

if [[ $# -lt 3 || $# -gt 5 ]]; then
    usage
fi

PROJECT_NAME="$1"
EDITION="$2"
VERSION="$3"
URL="${4:-}"
REGION="${5:-}"

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

# Region token (ADR-051): accept the hyphenated form the file names use and the
# underscored form the enum uses, and store the underscored one in the template.
REGION_TOKEN=""
if [[ -n "$REGION" ]]; then
    case "${REGION//-/_}" in
        indonesia | south_africa | india) REGION_TOKEN="${REGION//-/_}" ;;
        *)
            echo "ERROR: Invalid region '${REGION}'. Expected indonesia, south-africa or india." >&2
            exit 1
            ;;
    esac
fi

VER_TAG="${VERSION/./_}"

# The builder seals its templates as cartenz_tpl_<ver>_<edition>[_<region>];
# map the edition to the com/ent suffix rather than spelling the word out.
TEMPLATE_SUFFIX="com"
if [[ "$EDITION" == "enterprise" ]]; then
    TEMPLATE_SUFFIX="ent"
fi
TEMPLATE_BASE="cartenz_tpl_${VER_TAG}_${TEMPLATE_SUFFIX}"

template_exists() {
    sudo -u postgres psql -tAc \
        "SELECT 1 FROM pg_database WHERE datname = '$1' AND datistemplate" | grep -q 1
}

TEMPLATE=""
if [[ -n "$REGION_TOKEN" ]]; then
    REGION_TEMPLATE="${TEMPLATE_BASE}_${REGION_TOKEN}"
    if template_exists "$REGION_TEMPLATE"; then
        TEMPLATE="$REGION_TEMPLATE"
    else
        echo "WARN: the region template '${REGION_TEMPLATE}' was not found; falling" >&2
        echo "      back to '${TEMPLATE_BASE}'. Build it with build-standard-template.sh." >&2
    fi
fi
if [[ -z "$TEMPLATE" ]]; then
    TEMPLATE="$TEMPLATE_BASE"
fi

if ! template_exists "$TEMPLATE"; then
    echo "ERROR: the template database '${TEMPLATE}' does not exist (or is not a" >&2
    echo "template). Build it first:" >&2
    echo "  infrastructure/provisioning/build-standard-template.sh ${VERSION} \\" >&2
    echo "    ${EDITION} ${REGION_TOKEN:-indonesia}" >&2
    echo "  (or build-odoo-templates.sh for a source-built full installation)" >&2
    exit 1
fi

# Duplicate. This is the whole trick: files are copied, not replayed.
sudo -u postgres createdb -O "$ODOO_USER" -T "$TEMPLATE" "$PROJECT_NAME"

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

# Filestore (ADR-051): CREATE DATABASE does not copy it. When the template's
# filestore was stored, copy it into the clone's own data dir, keyed by the
# project's database name.
TEMPLATE_FS="${TEMPLATE_FILESTORE_DIR}/${TEMPLATE}"
if [[ -d "$TEMPLATE_FS" ]]; then
    DEST_FS="${PROJECTS_DIR}/${PROJECT_NAME}/data/filestore/${PROJECT_NAME}"
    mkdir -p "$DEST_FS"
    cp -a "${TEMPLATE_FS}/." "$DEST_FS/"
    if id "$ODOO_USER" >/dev/null 2>&1; then
        chown -R "${ODOO_USER}:${ODOO_USER}" "${PROJECTS_DIR}/${PROJECT_NAME}/data"
    fi
    echo "OK: filestore copied from ${TEMPLATE_FS}."
fi

echo "OK: database '${PROJECT_NAME}' created from '${TEMPLATE}' (all modules installed)."
