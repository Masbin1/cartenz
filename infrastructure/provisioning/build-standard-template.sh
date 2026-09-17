#!/usr/bin/env bash
set -Eeuo pipefail

# A neutral working directory: the `sudo -u postgres` children cannot chdir into
# a caller's home (root's /root is mode 700) and print a confusing warning.
cd /

# ============================================================
# LinkedERP - build a standard-database template (ADR-051)
# ============================================================
#
# Turns one of LinkedERP's standard Odoo databases (an Odoo backup zip: a
# `dump.sql` plus a `filestore/`) into a sealed PostgreSQL template that project
# provisioning duplicates from.
#
# One template per version, edition and region:
#
#   cartenz_tpl_<ver>_<com|ent>_<region>
#
# The archive is resolved from the repository's `database/` catalog:
#
#   database/linkederp-standard-<edition>-<region>-v<major>.zip
#   database/linkederp-standard-enterprise-indonesia-v19.zip
#   database/linkederp-standard-ce-south-africa-v18.zip
#
# `ce` is Community. The region may be given as `south-africa` or
# `south_africa`; the template name always uses the underscored form.
#
# The template is a Postgres database with `is_template = true` and
# `datallowconn = false`, so `CREATE DATABASE ... TEMPLATE` can clone it in
# seconds and nobody can connect to it and drift it. The archive's filestore is
# stored beside the templates so create-project-db.sh can copy it into each
# clone (PostgreSQL's CREATE DATABASE does not carry a filestore).
#
# Usage:
#   build-standard-template.sh <version> <community|enterprise> <region> [zip_path]
#
# Example:
#   build-standard-template.sh 19.0 enterprise indonesia
#   build-standard-template.sh 18.0 community south-africa /path/to/other.zip
#
# Requirements:
#   - run as root
#   - unzip, psql and createdb are installed
#   - the `odoo` Postgres role exists (used as the database owner)
#   - the dump was produced by Odoo's own backup, so its object owners are the
#     `odoo` role
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

PROJECTS_TEMPLATE_DIR="${TEMPLATE_FILESTORE_DIR:-/opt/odoo/templates/filestore}"
ODOO_USER="${ODOO_USER:-odoo}"

usage() {
    echo
    echo "Usage:"
    echo "  build-standard-template.sh <version> <community|enterprise> <region> [zip_path]"
    echo
    echo "Example:"
    echo "  build-standard-template.sh 19.0 enterprise indonesia"
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
EDITION="$2"
REGION="$3"
ZIP_ARG="${4:-}"

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+$ ]]; then
    echo "ERROR: Invalid version '${VERSION}'. Expected something like 19.0." >&2
    exit 1
fi

if [[ "$EDITION" != "community" && "$EDITION" != "enterprise" ]]; then
    echo "ERROR: edition must be 'community' or 'enterprise', got '${EDITION}'." >&2
    exit 1
fi

REGION_TOKEN=""
case "${REGION//-/_}" in
    indonesia | south_africa | india) REGION_TOKEN="${REGION//-/_}" ;;
    *)
        echo "ERROR: Invalid region '${REGION}'. Expected indonesia, south-africa or india." >&2
        exit 1
        ;;
esac
REGION_DASHED="${REGION_TOKEN//_/-}"

VER_TAG="${VERSION/./_}"
VER_MAJOR="${VERSION%%.*}"
TEMPLATE_SUFFIX="com"
EDITION_TOKEN="ce"
if [[ "$EDITION" == "enterprise" ]]; then
    TEMPLATE_SUFFIX="ent"
    EDITION_TOKEN="enterprise"
fi

TEMPLATE="cartenz_tpl_${VER_TAG}_${TEMPLATE_SUFFIX}_${REGION_TOKEN}"
SCRATCH="cartenz_tplbuild_${VER_TAG}_${TEMPLATE_SUFFIX}_${REGION_TOKEN}"

DEFAULT_ZIP="${REPO_ROOT}/database/linkederp-standard-${EDITION_TOKEN}-${REGION_DASHED}-v${VER_MAJOR}.zip"
ZIP="${ZIP_ARG:-$DEFAULT_ZIP}"

if [[ ! -f "$ZIP" ]]; then
    echo "ERROR: the standard database archive was not found:" >&2
    echo "  ${ZIP}" >&2
    echo "Put the file in the repository's database/ folder, or pass its path as" >&2
    echo "the fourth argument. See database/README.md." >&2
    exit 1
fi

if ! command -v unzip >/dev/null 2>&1; then
    echo "ERROR: unzip is required." >&2
    exit 1
fi

if ! command -v psql >/dev/null 2>&1 || ! command -v createdb >/dev/null 2>&1; then
    echo "ERROR: psql and createdb are required (postgresql-client)." >&2
    exit 1
fi

if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname = '${ODOO_USER}'" | grep -q 1; then
    echo "ERROR: the '${ODOO_USER}' Postgres role does not exist." >&2
    exit 1
fi

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

echo "=== Extracting $(basename "$ZIP") ==="
# Refuse an archive that would write outside the working directory: a backup is
# operator-supplied, but so is every other input, and this is a root process.
if unzip -Z1 "$ZIP" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
    echo "ERROR: the archive contains an absolute or parent-traversal path; refusing." >&2
    exit 1
fi
unzip -qq "$ZIP" -d "$WORKDIR/extracted"

DUMP="$(find "$WORKDIR/extracted" -maxdepth 2 -name dump.sql -type f | head -n 1)"
if [[ -z "$DUMP" ]]; then
    echo "ERROR: no dump.sql was found in the archive. Expected an Odoo backup" >&2
    echo "(dump.sql plus filestore/)." >&2
    exit 1
fi

echo "=== Restoring into scratch database ${SCRATCH} ==="
sudo -u postgres dropdb --if-exists "$SCRATCH"
sudo -u postgres createdb -O "$ODOO_USER" "$SCRATCH"

# Restore as postgres. Odoo's own backup carries ALTER ... OWNER statements for
# the odoo role, which exists, so the restored objects end up owned by it.
sudo -u postgres psql -v ON_ERROR_STOP=1 -q -d "$SCRATCH" -f "$DUMP" >/dev/null

# Filestore: store it beside the templates, keyed by template name, so
# create-project-db.sh can copy it into each clone. PSQL restore does not.
FILESTORE_SRC="$(find "$WORKDIR/extracted" -maxdepth 2 -type d -name filestore | head -n 1)"
if [[ -n "$FILESTORE_SRC" && -n "$(ls -A "$FILESTORE_SRC" 2>/dev/null)" ]]; then
    FILESTORE_DEST="${PROJECTS_TEMPLATE_DIR}/${TEMPLATE}"
    rm -rf "$FILESTORE_DEST"
    mkdir -p "$FILESTORE_DEST"
    cp -a "${FILESTORE_SRC}/." "$FILESTORE_DEST/"
    chown -R "${ODOO_USER}:${ODOO_USER}" "$FILESTORE_DEST"
    echo "OK: filestore stored at ${FILESTORE_DEST}."
else
    echo "NOTE: the archive has no filestore; clones will start with an empty one."
fi

# Seal it: rename to its final name, then mark it a template that accepts no
# connections. is_template is what lets CREATE DATABASE ... TEMPLATE use it;
# datallowconn=false satisfies PostgreSQL's own rule and protects the template
# from being drifted.
sudo -u postgres dropdb --if-exists "$TEMPLATE"
sudo -u postgres psql -v ON_ERROR_STOP=1 \
    -c "ALTER DATABASE \"${SCRATCH}\" RENAME TO \"${TEMPLATE}\";" \
    -c "ALTER DATABASE \"${TEMPLATE}\" WITH is_template true;" \
    -c "UPDATE pg_database SET datallowconn = false WHERE datname = '${TEMPLATE}';" >/dev/null

echo
echo "OK: ${TEMPLATE} is a sealed template database (${EDITION}, ${REGION_DASHED}, ${VERSION})."
echo "New projects of that version, edition and region clone it in seconds:"
echo "  cartenz_tpl_${VER_TAG}_${TEMPLATE_SUFFIX}_${REGION_TOKEN}"
