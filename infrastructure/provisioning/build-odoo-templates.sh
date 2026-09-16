#!/usr/bin/env bash
set -Eeuo pipefail

# A neutral working directory: the `sudo -u postgres` children cannot chdir into
# a caller's home (root's /root is mode 700) and print a confusing warning.
cd /

# ============================================================
# LinkedERP - build Odoo template databases (ADR-045)
# ============================================================
#
# Builds the "full installation" template databases that new project
# provisioning duplicates from, instead of installing modules per project.
#
# One template per version and edition:
#
#   cartenz_tpl_<ver>_com    every Community module installed
#   cartenz_tpl_<ver>_ent    every Enterprise + Community module installed
#
# A template is a Postgres database with `is_template = true` and
# `datallowconn = false`, so `CREATE DATABASE ... TEMPLATE ...` can clone it
# in seconds and nobody can connect to it and drift it.
#
# This is the one-time cost of the feature: an enterprise full install can
# take tens of minutes. Run it once per Odoo version, as the operator, and
# re-run it whenever the module set should be refreshed.
#
# Usage:
#   build-odoo-templates.sh <version> <base_path> <python> [enterprise_path]
#
# Example:
#   build-odoo-templates.sh 19.0 /opt/odoo/versions/19.0/odoo \
#     /opt/odoo/venv19/bin/python /opt/odoo/versions/19.0/enterprise
#
# Requirements:
#   - run as root (it creates databases as postgres and starts Odoo)
#   - the Odoo runtime for <version> is installed (python can import odoo)
#   - the `odoo` Postgres role exists (used as the database owner)
# ============================================================

usage() {
    echo
    echo "Usage:"
    echo "  build-odoo-templates.sh <version> <base_path> <python> [enterprise_path]"
    echo
    echo "Example:"
    echo "  build-odoo-templates.sh 19.0 /opt/odoo/versions/19.0/odoo \\"
    echo "    /opt/odoo/venv19/bin/python /opt/odoo/versions/19.0/enterprise"
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

VERSION="$1"
BASE_PATH="$2"
PYTHON="$3"
ENTERPRISE_PATH="${4:-}"

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+$ ]]; then
    echo "ERROR: Invalid version '${VERSION}'. Expected something like 19.0." >&2
    exit 1
fi

VER_TAG="${VERSION/./_}"

if [[ ! -f "${BASE_PATH}/odoo-bin" ]]; then
    echo "ERROR: ${BASE_PATH} does not contain odoo-bin. The base path must be the" >&2
    echo "Odoo repo root (the one holding odoo-bin and addons/), not odoo/addons." >&2
    exit 1
fi

if ! command -v psql >/dev/null 2>&1 || ! command -v createdb >/dev/null 2>&1; then
    echo "ERROR: psql and createdb are required (postgresql-client)." >&2
    exit 1
fi

if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname = 'odoo'" | grep -q 1; then
    echo "ERROR: the 'odoo' Postgres role does not exist." >&2
    exit 1
fi

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

# Odoo runs as the `odoo` user, authenticated by peer credentials over the
# local socket (the same way every provisioned instance connects — the role has
# no TCP password). The scratch directory must belong to that user.
mkdir -p "$WORKDIR/data"
chown -R odoo:odoo "$WORKDIR"

# A throwaway conf pointing at exactly the addons of one edition.
write_conf() {
    local conf="$1"
    local addons="$2"
    {
        echo "[options]"
        echo "addons_path = ${addons}"
        # No db_host/db_port/db_password: local socket + peer auth as role odoo.
        echo "db_user = odoo"
        echo "data_dir = ${WORKDIR}/data"
        echo "without_demo = all"
    } > "$conf"
}

# Builds one template: scratch database -> full install -> seal as template.
build_template() {
    local edition="$1"   # community | enterprise
    local template="$2"  # cartenz_tpl_<ver>_com | cartenz_tpl_<ver>_ent
    local scratch="cartenz_tplbuild_${VER_TAG}_${edition}"

    local addons="${BASE_PATH}/addons"
    if [[ "$edition" == "enterprise" ]]; then
        if [[ -z "$ENTERPRISE_PATH" || ! -d "$ENTERPRISE_PATH" ]]; then
            echo "SKIP ${template}: no enterprise path given." >&2
            return 0
        fi
        addons="${ENTERPRISE_PATH},${addons}"
    fi

    local conf="${WORKDIR}/${edition}.conf"
    write_conf "$conf" "$addons"

    echo "=== Building ${template} (this is the slow part: installing all modules) ==="

    sudo -u postgres dropdb --if-exists "$scratch"
    sudo -u postgres createdb -O odoo "$scratch"

    set +e
    sudo -u odoo -H "$PYTHON" "${BASE_PATH}/odoo-bin" \
        -c "$conf" \
        -d "$scratch" \
        -i all \
        --without-demo=all \
        --stop-after-init \
        --no-http \
        --logfile "${WORKDIR}/${edition}.log"
    local exit_code=$?
    set -e

    if [[ $exit_code -ne 0 ]]; then
        echo "ERROR: the full install for ${edition} failed (exit ${exit_code})." >&2
        # The workdir is deleted on exit; keep the Odoo log where it can be read.
        LOG_KEEP="/tmp/cartenz-tplbuild-${VER_TAG}-${edition}.log"
        cp -f "${WORKDIR}/${edition}.log" "$LOG_KEEP" 2>/dev/null || true
        echo "See ${LOG_KEEP} for the Odoo log." >&2
        sudo -u postgres dropdb --if-exists "$scratch"
        exit 1
    fi

    # Seal it: rename to its final name, then mark it a template that accepts
    # no connections. is_template is what lets CREATE DATABASE ... TEMPLATE use
    # it; datallowconn=false both satisfies PostgreSQL's own rule that a
    # non-template source must not accept connections, and protects the
    # template from being drifted.
    sudo -u postgres psql -v ON_ERROR_STOP=1 -c "ALTER DATABASE \"${scratch}\" RENAME TO \"${template}\";" \
        -c "ALTER DATABASE \"${template}\" WITH is_template true;" \
        -c "UPDATE pg_database SET datallowconn = false WHERE datname = '${template}';"

    echo "OK: ${template} is a sealed template database."
}

build_template "community" "cartenz_tpl_${VER_TAG}_com"
build_template "enterprise" "cartenz_tpl_${VER_TAG}_ent"

echo
echo "Done. New projects of version ${VERSION} can now be provisioned by"
echo "duplicating these templates:"
echo
echo "  cartenz_tpl_${VER_TAG}_com   (community, full installation)"
echo "  cartenz_tpl_${VER_TAG}_ent   (enterprise, full installation)"
