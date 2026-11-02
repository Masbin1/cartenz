#!/usr/bin/env bash
set -Eeuo pipefail

# ============================================================
# LinkedERP - read/write Odoo business records on-premise (ADR-075)
# ============================================================
#
# Runs as root (via the narrow sudoers rule in
# infrastructure/provisioning/99-linkederp-provisioning), so the platform's
# "cartenz" user can read or write business records on a provisioned
# project's own database without being granted any general database access
# or the ability to run arbitrary code as the "odoo" user.
#
# Mirrors apply-db-setup.sh exactly: the request is JSON, read from this
# script's stdin, never a shell argument. `odoo-bin shell` reads PYTHON
# SOURCE from its own stdin, so the request cannot share that pipe - it is
# written to a private root-owned temp file instead, and the FIXED driver
# (project-records-driver.py, installed beside this script, never generated
# per project, never model-authored) is fed to odoo-bin shell's stdin; the
# driver reads the request back from the path in
# PROJECT_RECORDS_REQUEST_FILE.
#
# This script does not interpret the request itself. The driver never
# executes a request entry as Python: a request is data (operation name,
# model name, field names, values), re-checked against the live ORM
# registry's own _fields before touching anything.
#
# Usage:
#   project-records.sh <project_name>
#
# stdin: the JSON request, shaped as
#   {"operation": "search"|"count"|"aggregate"|"create"|"write", "model": "...", ...}
#
# Output: one JSON line on stdout, prefixed "RECORDS_REPORT: ". Every
# diagnostic goes to stderr.
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRIVER="${SCRIPT_DIR}/project-records-driver.py"

usage() {
    echo
    echo "Usage:"
    echo "  project-records.sh <project_name>"
    echo
    echo "Reads the JSON request from stdin."
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

# Same floor as every other provisioning script: a project name is what
# create_project accepted when the project was made, not an arbitrary string
# reaching a root-run shell command.
if [[ ! "$PROJECT_NAME" =~ ^[a-z0-9][a-z0-9_-]{1,30}$ ]]; then
    echo "ERROR: Invalid project name." >&2
    exit 1
fi

if [[ ! -f "$DRIVER" ]]; then
    echo "ERROR: project-records-driver.py not found beside this script at ${DRIVER}." >&2
    exit 1
fi

if [[ ! -f "${SCRIPT_DIR}/odoo_record_policy.py" ]]; then
    echo "ERROR: odoo_record_policy.py not found beside this script." >&2
    exit 1
fi

# Each Odoo major version's projects live under its own BASE_DIR, each with
# its own venv and odoo-bin - mirrors apply-db-setup.sh exactly.
PROJECT_DIR=""
BASE_DIR=""
for candidate_base in /opt/odoo /opt/odoo20; do
    if [[ -d "${candidate_base}/projects/${PROJECT_NAME}" ]]; then
        PROJECT_DIR="${candidate_base}/projects/${PROJECT_NAME}"
        BASE_DIR="$candidate_base"
        break
    fi
done

if [[ -z "$PROJECT_DIR" ]]; then
    echo "ERROR: Project directory does not exist under any known runtime: ${PROJECT_NAME}" >&2
    exit 1
fi

CONFIG_FILE="${PROJECT_DIR}/config/odoo.conf"
VENV_PYTHON="${BASE_DIR}/venv/bin/python"
ODOO_BIN="${BASE_DIR}/odoo-server/odoo-bin"
ODOO_USER="odoo"

if [[ ! -f "$CONFIG_FILE" ]]; then
    echo "ERROR: Odoo config not found: ${CONFIG_FILE}" >&2
    exit 1
fi

if [[ ! -x "$VENV_PYTHON" ]]; then
    echo "ERROR: Odoo venv Python not found or not executable: ${VENV_PYTHON}" >&2
    exit 1
fi

if [[ ! -f "$ODOO_BIN" ]]; then
    echo "ERROR: odoo-bin not found: ${ODOO_BIN}" >&2
    exit 1
fi

# Mirrors apply-db-setup.sh: the database name is read from the project's own
# config, never derived from the project name or passed as an argument.
DB_NAME="$(sed -nE 's/^[[:space:]]*db_name[[:space:]]*=[[:space:]]*([A-Za-z0-9_-]+).*/\1/p' "$CONFIG_FILE" | head -1)"

if [[ -z "$DB_NAME" ]]; then
    echo "ERROR: Could not read db_name from ${CONFIG_FILE}." >&2
    exit 1
fi

# 19.0 projects run on 5432, 20.0 on 5433 (ADR-045) - read db_port from the
# same config, defaulting to 5432 only when the conf omits it.
PG_PORT="$(sed -nE 's/^[[:space:]]*db_port[[:space:]]*=[[:space:]]*([0-9]+).*/\1/p' "$CONFIG_FILE" | head -1)"
PG_PORT="${PG_PORT:-5432}"

if ! sudo -u postgres psql -p "$PG_PORT" -tAc "SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'" | grep -q 1; then
    echo "ERROR: Database '${DB_NAME}' does not exist on port ${PG_PORT}." >&2
    exit 1
fi

# --- Request, read from stdin, written to a private temp file --------------
#
# This script never interprets the request itself. The temp file exists only
# so the request can reach the driver through an environment variable rather
# than odoo-bin shell's own stdin, which the driver source occupies instead.
REQUEST="$(cat)"

if [[ -z "$REQUEST" ]]; then
    echo "ERROR: No request was given on stdin." >&2
    exit 1
fi

REQUEST_FILE="$(mktemp /tmp/linkederp-records-XXXXXXXX.json)"
cleanup() { rm -f "$REQUEST_FILE"; }
trap cleanup EXIT

# mktemp already made the file 0600 root-only. Write first, hand over second:
# /tmp is sticky and world-writable, and with fs.protected_regular set the
# kernel refuses even root an O_CREAT open of a file there owned by another
# user, so chown-then-write fails with "Permission denied".
printf '%s' "$REQUEST" > "$REQUEST_FILE"
chmod 600 "$REQUEST_FILE"
chown "$ODOO_USER" "$REQUEST_FILE"

# Run as the "odoo" user: the driver needs the same database/filestore
# access the running instance already has, and running as root here would
# leave anything it writes owned by root for an instance everything else
# treats as odoo:odoo.
# The log stays root-owned: the redirect below is opened by this (root) shell
# before sudo drops to odoo, and odoo-bin only writes through the inherited
# descriptor.
LOG_FILE="$(mktemp "/tmp/cartenz-records-${PROJECT_NAME}-XXXXXXXX.log")"
set +e
sudo -u "$ODOO_USER" \
    PROJECT_RECORDS_REQUEST_FILE="$REQUEST_FILE" \
    PROJECT_RECORDS_POLICY_DIR="$SCRIPT_DIR" \
    "$VENV_PYTHON" "$ODOO_BIN" shell \
    -c "$CONFIG_FILE" -d "$DB_NAME" --no-http --shell-interface=python \
    < "$DRIVER" > "$LOG_FILE" 2>&1
DRIVER_EXIT=$?
set -e

# The driver prints exactly one report line prefixed "RECORDS_REPORT: " so it
# can be picked out of odoo-bin's own banner/log noise on stdout; every other
# line in the log is diagnostic only.
grep '^RECORDS_REPORT: ' "$LOG_FILE" | sed 's/^RECORDS_REPORT: //' || true

if [[ $DRIVER_EXIT -ne 0 ]]; then
    echo "ERROR: the records driver exited ${DRIVER_EXIT}. Full log: ${LOG_FILE}" >&2
    # The log is root-owned (it must be: it is written through this shell's
    # descriptor before sudo drops to odoo), so without this the reason a run
    # failed is readable only by root - while the service that shows the
    # message runs as "cartenz". Echo the tail for whoever reads the reply.
    tail -n 20 "$LOG_FILE" >&2 || true
    exit "$DRIVER_EXIT"
fi
