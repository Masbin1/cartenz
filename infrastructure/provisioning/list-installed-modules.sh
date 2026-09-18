#!/usr/bin/env bash
set -Eeuo pipefail

# ============================================================
# LinkedERP - list a project's installed modules (ADR-056)
# ============================================================
#
# Runs as root (via the narrow sudoers rule in
# infrastructure/provisioning/99-linkederp-provisioning), so the platform's
# "cartenz" user can show what is actually installed in a provisioned
# project's own database without being granted any general database access.
#
# It is deliberately a single whitelisted read, not a general query tool:
#   SELECT name, state FROM ir_module_module ORDER BY name
# against exactly the one database the project's own odoo.conf names. There
# is no argument that lets a caller choose a different table, a different
# database, or a write.
#
# Usage:
#   list-installed-modules.sh <project_name>
#
# Output: one "name\tstate" pair per line, tab-separated, to stdout. Every
# diagnostic goes to stderr, so stdout is always clean to parse.
#
# Example:
#   list-installed-modules.sh dodolbintangmas
# ============================================================

BASE_DIR="/opt/odoo"
PROJECTS_DIR="${BASE_DIR}/projects"

usage() {
    echo
    echo "Usage:"
    echo "  list-installed-modules.sh <project_name>"
    echo
    exit 1
}

if [[ "$EUID" -ne 0 ]]; then
    echo "ERROR: This script must be run as root." >&2
    exit 1
fi

if [[ $# -ne 1 ]]; then
    usage
fi

PROJECT_NAME="$1"

# Same floor as grant-addons-write.sh: a project name is what create_project
# accepted when the project was made, not an arbitrary string reaching a
# root-run shell command.
if [[ ! "$PROJECT_NAME" =~ ^[a-z0-9][a-z0-9_-]{1,30}$ ]]; then
    echo "ERROR: Invalid project name." >&2
    exit 1
fi

PROJECT_DIR="${PROJECTS_DIR}/${PROJECT_NAME}"
CONFIG_FILE="${PROJECT_DIR}/config/odoo.conf"

if [[ ! -f "$CONFIG_FILE" ]]; then
    echo "ERROR: No odoo.conf at ${CONFIG_FILE}; is this a provisioned project?" >&2
    exit 1
fi

# Mirrors backup-project.sh: the database name is read from the project's own
# config, not derived from the project name, so this stays correct even if
# that ever diverges (it does not today, but nothing here should assume it).
DB_NAME="$(sed -nE 's/^[[:space:]]*db_name[[:space:]]*=[[:space:]]*([A-Za-z0-9_-]+).*/\1/p' "$CONFIG_FILE" | head -1)"

if [[ -z "$DB_NAME" ]]; then
    echo "ERROR: Could not read db_name from ${CONFIG_FILE}." >&2
    exit 1
fi

if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'" | grep -q 1; then
    echo "ERROR: Database '${DB_NAME}' does not exist." >&2
    exit 1
fi

# -A (unaligned) + -F$'\t' + -t (tuples only): a plain tab-separated stream,
# nothing to strip before parsing. ON_ERROR_STOP so a broken query fails
# loudly instead of printing a partial, silently-truncated list.
sudo -u postgres psql -v ON_ERROR_STOP=1 -d "$DB_NAME" -tA -F $'\t' \
    -c "SELECT name, state FROM ir_module_module ORDER BY name"
