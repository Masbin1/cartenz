#!/usr/bin/env bash
set -Eeuo pipefail

# A neutral working directory: the `sudo -u postgres` children cannot chdir into
# a caller's home (root's /root is mode 700) and print a confusing warning.
cd /

# ============================================================
# LinkedERP - per-client backup (ADR-054)
# ============================================================
#
# Takes a restorable snapshot of one project's estate: the Odoo database, the
# filestore, and a bundle of the addons repository - the three things a client's
# instance is made of. It runs as root because the project directory is
# `odoo:odoo` mode 750 and the database is owned by the `odoo` role, neither of
# which the platform's own user can read.
#
# Called two ways:
#
#   1. By the platform, through the narrow sudoers rule in
#      infrastructure/provisioning/99-linkederp-provisioning, before a push to a
#      staging (or main-named) branch (ADR-054). A push whose backup fails does
#      not proceed.
#   2. By an operator, directly as root, for a backup outside the platform.
#
# Usage:
#   backup-project.sh <project_name>
#
# Layout, one directory per run:
#
#   /opt/odoo/backups/<project>/<id>/
#       db.dump          pg_dump custom format (compressed)
#       filestore.tar.gz the Odoo filestore (attachments, generated documents)
#       addons.bundle    git bundle of the addons repository, all branches
#       manifest.json    written LAST: its presence marks the backup complete
#
# A restore is `restore-project.sh <project_name> <id>` (operator-run; see that
# script). Retention keeps the newest BACKUP_KEEP runs per project and removes
# older ones; nothing outside /opt/odoo/backups is ever touched.
#
# --- Host configuration (adapt if your layout differs) -----------------------
BASE_DIR="${BASE_DIR:-/opt/odoo}"
PROJECTS_DIR="${PROJECTS_DIR:-${BASE_DIR}/projects}"
BACKUP_ROOT="${BACKUP_ROOT:-${BASE_DIR}/backups}"
BACKUP_KEEP="${BACKUP_KEEP:-14}"
ODOO_USER="${ODOO_USER:-odoo}"
# -----------------------------------------------------------------------------

usage() {
    echo
    echo "Usage:"
    echo "  backup-project.sh <project_name>"
    echo
    echo "Example:"
    echo "  backup-project.sh dodolbintangmas"
    echo
    exit 1
}

fail() { echo "ERROR: $*" >&2; exit 1; }

if [[ "${EUID}" -ne 0 ]]; then
    echo "ERROR: This script must be run as root." >&2
    exit 1
fi

if [[ $# -ne 1 ]]; then
    usage
fi

PROJECT_NAME="$1"

if [[ ! "$PROJECT_NAME" =~ ^[a-z0-9][a-z0-9_-]{1,30}$ ]]; then
    fail "Invalid project name '${PROJECT_NAME}'. Expected lowercase letters, digits, hyphen and underscore, 2-31 characters."
fi

# Anchored to the configured projects root; never derived from the argument's
# own shape. `realpath -m` resolves a symlink or `..` in the recorded path, and
# the prefix check then refuses anything outside the root.
PROJECT_DIR="$(realpath -m "${PROJECTS_DIR}/${PROJECT_NAME}")"
[[ "$PROJECT_DIR" == "${PROJECTS_DIR}/"* ]] \
    || fail "Refusing '${PROJECT_NAME}': it does not resolve inside ${PROJECTS_DIR}."
[[ -d "$PROJECT_DIR" ]] || fail "No project directory at ${PROJECT_DIR}."

CONFIG_FILE="${PROJECT_DIR}/config/odoo.conf"
[[ -f "$CONFIG_FILE" ]] || fail "No odoo.conf at ${CONFIG_FILE}; is this a provisioned project?"

# The database name comes from the project's own odoo.conf, falling back to the
# project name (which is what create_project uses).
DB_NAME="$(sed -nE 's/^[[:space:]]*db_name[[:space:]]*=[[:space:]]*([A-Za-z0-9_-]+).*/\1/p' "$CONFIG_FILE" | head -1)"
DB_NAME="${DB_NAME:-$PROJECT_NAME}"

# The dump is taken as the `odoo` role would see it, through the postgres
# superuser on the local socket: the platform's own role can CONNECT but does
# not own the tables, so `pg_dump` as that role fails on orm_signaling_registry.
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'" | grep -q 1; then
    fail "Database '${DB_NAME}' does not exist; nothing to back up."
fi

ID="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="${BACKUP_ROOT}/${PROJECT_NAME}/${ID}"
FILESTORE_SRC="${PROJECT_DIR}/data/filestore/${DB_NAME}"
ADDONS_DIR="${PROJECT_DIR}/addons"

mkdir -p "$DEST"
chmod 750 "$BACKUP_ROOT" "${BACKUP_ROOT}/${PROJECT_NAME}" "$DEST"

cleanup_partial() {
    # A partial backup must never be mistaken for a restorable one. The manifest
    # is written last; removing the directory removes the ambiguity.
    rm -rf "$DEST" 2>/dev/null || true
}
trap 'cleanup_partial' ERR

echo "=== Backing up '${PROJECT_NAME}' (database '${DB_NAME}') -> ${DEST} ==="

# --- database ----------------------------------------------------------------
echo "--- database ---"
if ! sudo -u postgres pg_dump --format=custom --file="${DEST}/db.dump" "${DB_NAME}"; then
    fail "pg_dump failed for '${DB_NAME}'."
fi
[[ -s "${DEST}/db.dump" ]] || fail "pg_dump produced an empty file."

# --- filestore ---------------------------------------------------------------
FILESTORE_PRESENT=false
if [[ -d "$FILESTORE_SRC" ]]; then
    echo "--- filestore ---"
    tar -C "$(dirname "$FILESTORE_SRC")" -czf "${DEST}/filestore.tar.gz" "$(basename "$FILESTORE_SRC")"
    FILESTORE_PRESENT=true
else
    echo "--- filestore: none at ${FILESTORE_SRC} (a fresh instance has none) ---"
fi

# --- addons repository -------------------------------------------------------
ADDONS_PRESENT=false
ADDONS_HEAD=""
if [[ -d "${ADDONS_DIR}/.git" ]]; then
    echo "--- addons repository ---"
    # Run as the odoo user: a root-run git would leave root-owned objects in a
    # directory the running instance must keep writing to.
    sudo -u "$ODOO_USER" -H env GIT_CONFIG_NOSYSTEM=1 git \
        -c core.hooksPath=/dev/null \
        -C "$ADDONS_DIR" bundle create "${DEST}/addons.bundle" --all
    ADDONS_HEAD="$(sudo -u "$ODOO_USER" -H env GIT_CONFIG_NOSYSTEM=1 git -c core.hooksPath=/dev/null -C "$ADDONS_DIR" rev-parse HEAD 2>/dev/null || true)"
    ADDONS_PRESENT=true
else
    echo "--- addons: no git repository at ${ADDONS_DIR} ---"
fi

# --- manifest (last: its presence marks the backup complete) -----------------
SIZE_BYTES="$(du -sb "$DEST" | cut -f1)"
CREATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat > "${DEST}/manifest.json" <<EOF
{
  "project": "${PROJECT_NAME}",
  "id": "${ID}",
  "created_at": "${CREATED_AT}",
  "hostname": "$(hostname)",
  "database": "${DB_NAME}",
  "filestore": ${FILESTORE_PRESENT},
  "addons": { "present": ${ADDONS_PRESENT}, "head": "${ADDONS_HEAD}" },
  "size_bytes": ${SIZE_BYTES},
  "produced_by": "backup-project.sh (ADR-054)"
}
EOF
chmod 640 "${DEST}/db.dump" "${DEST}/manifest.json" 2>/dev/null || true
[[ -f "${DEST}/filestore.tar.gz" ]] && chmod 640 "${DEST}/filestore.tar.gz"
[[ -f "${DEST}/addons.bundle" ]] && chmod 640 "${DEST}/addons.bundle"

# --- retention: keep the newest BACKUP_KEEP runs ------------------------------
if [[ "$BACKUP_KEEP" =~ ^[0-9]+$ ]] && (( BACKUP_KEEP > 0 )); then
    mapfile -t OLD < <(find "${BACKUP_ROOT}/${PROJECT_NAME}" -mindepth 1 -maxdepth 1 -type d \
        -regextype posix-extended -regex '.*/[0-9]{8}T[0-9]{6}Z' | sort | head -n -"${BACKUP_KEEP}")
    for dir in "${OLD[@]:-}"; do
        [[ -n "$dir" ]] || continue
        echo "retention: removing ${dir}"
        rm -rf "$dir"
    done
fi

trap - ERR
echo "OK: backup ${ID} of '${PROJECT_NAME}' written to ${DEST} (${SIZE_BYTES} bytes)."
echo "BACKUP_ID=${ID}"
echo "BACKUP_PATH=${DEST}"
echo "BACKUP_SIZE_BYTES=${SIZE_BYTES}"
