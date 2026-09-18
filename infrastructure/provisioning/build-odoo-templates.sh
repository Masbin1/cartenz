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
#   cartenz_tpl_<ver>_com        every Community module installed
#   cartenz_tpl_<ver>_ent        every Enterprise + Community module installed
#   cartenz_tpl_<ver>_com_base   base only (ADR-056 selective installs clone this)
#   cartenz_tpl_<ver>_ent_base   base only (ADR-056 selective installs clone this)
#
# The `_base` pair exists so a project that asks for a handful of modules
# (ADR-056) can clone a near-empty database and install just those, instead of
# cloning a full installation it will not use. Full templates remain the
# default for every project that does not ask for a selection.
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
list_modules() {
    # Prints every module directory found in the given addons paths as a
    # comma-separated list, excluding test modules. stdlib only.
    local -a dirs=("$@")
    python3 - "${dirs[@]}" <<'PY'
import os, sys
names = set()
for ad in sys.argv[1:]:
    if not ad:
        continue
    for entry in sorted(os.listdir(ad)):
        p = os.path.join(ad, entry)
        if (os.path.isdir(p)
                and not entry.startswith(('.', 'test_'))
                and os.path.isfile(os.path.join(p, '__manifest__.py'))):
            names.add(entry)
print(','.join(sorted(names)))
PY
}

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
# `base_only=true` swaps the module list for the literal "base" (today's
# pre-ADR-045 behaviour, kept as its own named artefact per ADR-056 rather
# than being retired): the selective-install path (Task 7) clones this and
# runs `odoo-bin -i <selection>` against it instead of the full templates
# below, so a person choosing 3 modules is not paying for hundreds.
build_template() {
    local edition="$1"   # community | enterprise
    local template="$2"  # cartenz_tpl_<ver>_com | cartenz_tpl_<ver>_ent | ..._base
    local base_only="${3:-false}"
    local scratch="cartenz_tplbuild_${VER_TAG}_${edition}$([[ "$base_only" == true ]] && echo _base || true)"

    local addons="${BASE_PATH}/addons"
    if [[ "$edition" == "enterprise" ]]; then
        if [[ -z "$ENTERPRISE_PATH" || ! -d "$ENTERPRISE_PATH" ]]; then
            echo "SKIP ${template}: no enterprise path given." >&2
            return 0
        fi
        addons="${ENTERPRISE_PATH},${addons}"
    fi

    local modules module_count
    if [[ "$base_only" == true ]]; then
        modules="base"
        module_count=1
    else
        # Odoo 19 dropped the `-i all` expansion (the name `all` is now only
        # discarded by the module-name check, so `-i all` installs nothing but
        # base). Expand the list ourselves from the addons directories.
        local -a addons_dirs
        IFS=',' read -ra addons_dirs <<< "$addons"
        modules="$(list_modules "${addons_dirs[@]}")"
        if [[ -z "$modules" ]]; then
            echo "ERROR: no modules found under ${addons}" >&2
            exit 1
        fi
        module_count="$(awk -F, '{print NF}' <<< "$modules")"
    fi
    echo "Installing ${module_count} module(s) from: ${addons}"

    local conf="${WORKDIR}/${edition}.conf"
    write_conf "$conf" "$addons"

    echo "=== Building ${template} (this is the slow part: installing all modules) ==="

    sudo -u postgres dropdb --if-exists "$scratch"
    sudo -u postgres createdb -O odoo "$scratch"

    set +e
    sudo -u odoo -H "$PYTHON" "${BASE_PATH}/odoo-bin" \
        -c "$conf" \
        -d "$scratch" \
        -i "$modules" \
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

    # A refresh run replaces the previous template of this name; without this
    # the rename below fails on an existing name and strands the scratch
    # database.
    sudo -u postgres dropdb --if-exists "$template"

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
build_template "community" "cartenz_tpl_${VER_TAG}_com_base" true
build_template "enterprise" "cartenz_tpl_${VER_TAG}_ent_base" true

echo
echo "Done. New projects of version ${VERSION} can now be provisioned by"
echo "duplicating these templates:"
echo
echo "  cartenz_tpl_${VER_TAG}_com        (community, full installation)"
echo "  cartenz_tpl_${VER_TAG}_ent        (enterprise, full installation)"
echo "  cartenz_tpl_${VER_TAG}_com_base   (community, base only — selective installs clone this)"
echo "  cartenz_tpl_${VER_TAG}_ent_base   (enterprise, base only — selective installs clone this)"
