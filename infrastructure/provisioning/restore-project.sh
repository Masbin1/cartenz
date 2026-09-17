#!/usr/bin/env bash
set -Eeuo pipefail

cd /

# ============================================================
# LinkedERP - per-client restore (ADR-054)
# ============================================================
#
# Restores one project's estate from a backup taken by backup-project.sh. It is
# deliberately NOT wired to the platform and NOT in the sudoers rule: the whole
# point of an independent backup is that an operator with server access and no
# platform access can use it, and that custody of the backup and custody of the
# platform are separable.
#
# Usage:
#   restore-project.sh <project_name> <backup_id> [--yes]
#
# Without --yes it prints what it would do and exits; nothing is touched. With
# --yes it:
#
#   1. stops the project's systemd unit (the database cannot be replaced while
#      Odoo holds connections),
#   2. replaces the database from db.dump (drop + create + pg_restore as odoo),
#   3. moves the current filestore aside and extracts the archived one,
#   4. leaves addons/ alone and prints how to restore it (the repository's
#      remote is its primary copy; the bundle in the backup is the fallback),
#   5. starts the unit again.
#
# Everything it does is reversible up to the point the database is dropped: the
# old filestore is moved, not deleted, and the database dump it replaces was
# itself taken by a backup. The restore is expected to be exercised as a drill
# (see docs/architecture/client-estate-and-server-architecture.md 4.2).
#
# --- Host configuration (adapt if your layout differs) -----------------------
BASE_DIR="${BASE_DIR:-/opt/odoo}"
PROJECTS_DIR="${PROJECTS_DIR:-${BASE_DIR}/projects}"
BACKUP_ROOT="${BACKUP_ROOT:-${BASE_DIR}/backups}"
ODOO_USER="${ODOO_USER:-odoo}"
# -----------------------------------------------------------------------------

usage() {
    echo
    echo "Usage:"
    echo "  restore-project.sh <project_name> <backup_id> [--yes]"
    echo
    echo "Example:"
    echo "  restore-project.sh dodolbintangmas 20260918T031500Z --yes"
    echo
    exit 1
}

fail() { echo "ERROR: $*" >&2; exit 1; }

if [[ "${EUID}" -ne 0 ]]; then
    echo "ERROR: This script must be run as root." >&2
    exit 1
fi

if [[ $# -lt 2 || $# -gt 3 ]]; then
    usage
fi

PROJECT_NAME="$1"
BACKUP_ID="$2"
CONFIRM="${3:-}"

[[ "$CONFIRM" == "--yes" || -z "$CONFIRM" ]] || usage

if [[ ! "$PROJECT_NAME" =~ ^[a-z0-9][a-z0-9_-]{1,30}$ ]]; then
    fail "Invalid project name '${PROJECT_NAME}'."
fi
if [[ ! "$BACKUP_ID" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]; then
    fail "Invalid backup id '${BACKUP_ID}'. Expected the form 20260918T031500Z."
fi

PROJECT_DIR="$(realpath -m "${PROJECTS_DIR}/${PROJECT_NAME}")"
[[ "$PROJECT_DIR" == "${PROJECTS_DIR}/"* ]] \
    || fail "Refusing '${PROJECT_NAME}': it does not resolve inside ${PROJECTS_DIR}."
[[ -d "$PROJECT_DIR" ]] || fail "No project directory at ${PROJECT_DIR}."

CONFIG_FILE="${PROJECT_DIR}/config/odoo.conf"
[[ -f "$CONFIG_FILE" ]] || fail "No odoo.conf at ${CONFIG_FILE}."

DB_NAME="$(sed -nE 's/^[[:space:]]*db_name[[:space:]]*=[[:space:]]*([A-Za-z0-9_-]+).*/\1/p' "$CONFIG_FILE" | head -1)"
DB_NAME="${DB_NAME:-$PROJECT_NAME}"

BACKUP_DIR="${BACKUP_ROOT}/${PROJECT_NAME}/${BACKUP_ID}"
[[ -d "$BACKUP_DIR" ]] || fail "No backup at ${BACKUP_DIR}."
# The manifest is written last by the backup, so its presence means the backup
# completed; a directory without one is a partial run and must not be restored.
[[ -f "${BACKUP_DIR}/manifest.json" ]] || fail "The backup at ${BACKUP_DIR} has no manifest.json; it is incomplete and will not be restored."
[[ -f "${BACKUP_DIR}/db.dump" ]] || fail "The backup at ${BACKUP_DIR} has no db.dump."

UNIT="odoo-${PROJECT_NAME}.service"
WAS_ACTIVE=false
if systemctl is-active --quiet "$UNIT" 2>/dev/null; then
    WAS_ACTIVE=true
fi

echo "=== Restore plan for '${PROJECT_NAME}' ==="
echo "  project directory : ${PROJECT_DIR}"
echo "  database          : ${DB_NAME}  (replaced from ${BACKUP_DIR}/db.dump)"
if [[ -f "${BACKUP_DIR}/filestore.tar.gz" ]]; then
    echo "  filestore         : replaced (current one moved aside, not deleted)"
else
    echo "  filestore         : not present in this backup - left as is"
fi
echo "  addons/           : NOT touched (restore from the remote, or the bundle)"
echo "  service           : ${UNIT} $( [[ "$WAS_ACTIVE" == true ]] && echo '(stopped, then started again)' || echo '(not running)' )"
echo

if [[ "$CONFIRM" != "--yes" ]]; then
    echo "Nothing was changed. Re-run with --yes to perform the restore."
    exit 1
fi

echo "=== Restoring '${PROJECT_NAME}' from ${BACKUP_ID} ==="

# --- 1. stop the unit --------------------------------------------------------
if [[ "$WAS_ACTIVE" == true ]]; then
    echo "--- stopping ${UNIT} ---"
    systemctl stop "$UNIT"
fi

# --- 2. database -------------------------------------------------------------
echo "--- replacing database '${DB_NAME}' ---"
sudo -u postgres dropdb --if-exists "$DB_NAME"
sudo -u postgres createdb -O "$ODOO_USER" "$DB_NAME"
sudo -u postgres pg_restore --role="$ODOO_USER" --dbname="$DB_NAME" "${BACKUP_DIR}/db.dump"

# --- 3. filestore ------------------------------------------------------------
if [[ -f "${BACKUP_DIR}/filestore.tar.gz" ]]; then
    echo "--- restoring filestore ---"
    FILESTORE_ROOT="${PROJECT_DIR}/data/filestore"
    mkdir -p "$FILESTORE_ROOT"
    if [[ -d "${FILESTORE_ROOT}/${DB_NAME}" ]]; then
        mv "${FILESTORE_ROOT}/${DB_NAME}" "${FILESTORE_ROOT}/${DB_NAME}.pre-restore-$(date -u +%Y%m%dT%H%M%SZ)"
    fi
    tar -C "$FILESTORE_ROOT" -xzf "${BACKUP_DIR}/filestore.tar.gz"
    chown -R "${ODOO_USER}:${ODOO_USER}" "${PROJECT_DIR}/data"
fi

# --- 4. addons: deliberately not touched --------------------------------------
if [[ -f "${BACKUP_DIR}/addons.bundle" ]]; then
    echo
    echo "addons/ was NOT restored. The repository's remote is its primary copy; if it is"
    echo "gone too, the bundle in this backup holds every branch:"
    echo
    echo "  sudo -u ${ODOO_USER} -H git bundle list-heads ${BACKUP_DIR}/addons.bundle"
    echo "  sudo -u ${ODOO_USER} -H git clone ${BACKUP_DIR}/addons.bundle /tmp/addons-restored"
    echo
fi

# --- 5. start the unit again --------------------------------------------------
if [[ "$WAS_ACTIVE" == true ]]; then
    echo "--- starting ${UNIT} ---"
    systemctl start "$UNIT"
fi

echo "OK: '${PROJECT_NAME}' restored from backup ${BACKUP_ID}."
