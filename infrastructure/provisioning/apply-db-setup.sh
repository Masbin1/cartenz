#!/usr/bin/env bash
set -Eeuo pipefail

# ============================================================
# LinkedERP - apply a fit-gap database setup plan (ADR-073)
# ============================================================
#
# Runs as root (via the narrow sudoers rule in
# infrastructure/provisioning/99-linkederp-provisioning), so the platform's
# "cartenz" user can apply a reviewed configuration plan to a provisioned
# project's own database without being granted any general database access
# or the ability to run arbitrary code as the "odoo" user.
#
# The plan is JSON, read from this script's stdin, never a shell argument —
# the same stdin-credential convention pull-project.sh and
# restart-project.sh already use to keep sensitive or structured input out
# of argv. It is the platform's only input to this script: everything else
# (the database name, the Odoo source for this project's version, the Python
# interpreter) is resolved on the host exactly the way
# list-installed-modules.sh and restart-project.sh already resolve it.
#
# `odoo-bin shell` reads PYTHON SOURCE from its own stdin when stdin is not a
# tty (odoo/cli/shell.py: exec(sys.stdin.read(), local_vars)) — so this
# script's stdin (the plan) and odoo-bin shell's stdin (the driver source)
# cannot be the same pipe. The plan is instead written to a private temp file
# this script owns for the duration of the run, and the FIXED driver
# (apply-db-setup-driver.py, installed beside this script, never generated
# per project, never model-authored) is fed to odoo-bin shell's stdin; the
# driver reads the plan back from the path in DB_SETUP_PLAN_FILE.
#
# This script does not interpret the plan itself, and the driver never
# executes a plan entry as Python: a plan is data (model name, field names,
# values). The driver re-checks every field name against the live ORM
# registry's own _fields before touching anything, exactly once, as defence
# in depth behind the backend's own catalog check.
#
# Usage:
#   apply-db-setup.sh <project_name>
#
# stdin: the JSON plan, shaped as {"configuration": [{"kind": "...", ...}]}
# (the same shape odoo-setup-plan.ts validates before this is ever called).
#
# Output: the driver's own JSON lines, one per plan entry
#   ({"item": N, "status": "applied"|"skipped"|"failed", "detail": "..."}),
# to stdout. Every diagnostic goes to stderr.
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRIVER="${SCRIPT_DIR}/apply-db-setup-driver.py"

usage() {
    echo
    echo "Usage:"
    echo "  apply-db-setup.sh <project_name>"
    echo
    echo "Reads the JSON setup plan from stdin."
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
    echo "ERROR: apply-db-setup-driver.py not found beside this script at ${DRIVER}." >&2
    exit 1
fi

# Each Odoo major version's projects live under its own BASE_DIR, each with
# its own venv and odoo-bin (ADR: 20.0-separate-runtime) — mirrors
# restart-project.sh and grant-addons-write.sh exactly.
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

# Mirrors list-installed-modules.sh: the database name is read from the
# project's own config, never derived from the project name or passed as an
# argument.
DB_NAME="$(sed -nE 's/^[[:space:]]*db_name[[:space:]]*=[[:space:]]*([A-Za-z0-9_-]+).*/\1/p' "$CONFIG_FILE" | head -1)"

if [[ -z "$DB_NAME" ]]; then
    echo "ERROR: Could not read db_name from ${CONFIG_FILE}." >&2
    exit 1
fi

# The database lives on the project's own cluster, not on a fixed one: 19.0
# projects are created on 5432 and 20.0 projects on 5433 (ADR-045). A bare
# `psql` only ever sees the first, so a 20.0 project's database is invisible
# to it — read db_port from the same config, exactly as backup-project.sh
# does, and default to 5432 only when the conf omits it.
PG_PORT="$(sed -nE 's/^[[:space:]]*db_port[[:space:]]*=[[:space:]]*([0-9]+).*/\1/p' "$CONFIG_FILE" | head -1)"
PG_PORT="${PG_PORT:-5432}"

if ! sudo -u postgres psql -p "$PG_PORT" -tAc "SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'" | grep -q 1; then
    echo "ERROR: Database '${DB_NAME}' does not exist on port ${PG_PORT}." >&2
    exit 1
fi

# --- Plan, read from stdin, written to a private temp file ------------------
#
# This script never interprets the plan itself. The temp file exists only so
# the plan can reach the driver through an environment variable rather than
# odoo-bin shell's own stdin, which the driver source occupies instead.
PLAN="$(cat)"

if [[ -z "$PLAN" ]]; then
    echo "ERROR: No plan was given on stdin." >&2
    exit 1
fi

PLAN_FILE="$(mktemp /tmp/linkederp-db-setup-XXXXXXXX.json)"
cleanup() { rm -f "$PLAN_FILE"; }
trap cleanup EXIT

# Write first, hand over second. /tmp is sticky and world-writable, and with
# fs.protected_regular set the kernel refuses even root an O_CREAT open of a
# file there owned by another user, so chown-then-write fails with
# "Permission denied". mktemp already made the file 0600 root-only, so it is
# never readable by anyone else while it holds the plan.
printf '%s' "$PLAN" > "$PLAN_FILE"
chmod 600 "$PLAN_FILE"
chown "$ODOO_USER" "$PLAN_FILE"

# Run as the "odoo" user, the same user restart-project.sh upgrades modules
# as: the driver needs the same database/filestore access `-u all` already
# has, and running as root here would leave anything it writes owned by root
# for an instance everything else treats as odoo:odoo.
# The log stays root-owned: the redirect below is opened by this (root) shell
# before sudo drops to odoo, and odoo-bin only writes through the inherited
# descriptor. Chowning it first would trip fs.protected_regular as above.
LOG_FILE="$(mktemp "/tmp/cartenz-db-setup-${PROJECT_NAME}-XXXXXXXX.log")"
set +e
sudo -u "$ODOO_USER" DB_SETUP_PLAN_FILE="$PLAN_FILE" "$VENV_PYTHON" "$ODOO_BIN" shell \
    -c "$CONFIG_FILE" -d "$DB_NAME" --no-http --shell-interface=python \
    < "$DRIVER" > "$LOG_FILE" 2>&1
DRIVER_EXIT=$?
set -e

# The driver prints its JSON report lines prefixed with "DB_SETUP_REPORT: " so
# they can be picked out of odoo-bin's own banner/log noise on stdout; every
# other line in the log is diagnostic only. `|| true` matters: a plan with no
# entries (or one whose every entry died before reporting) leaves nothing to
# grep, and under `set -e`/`pipefail` a bare grep would then kill the script
# with exit 1 and print no reason at all.
grep '^DB_SETUP_REPORT: ' "$LOG_FILE" | sed 's/^DB_SETUP_REPORT: //' || true

if [[ $DRIVER_EXIT -ne 0 ]]; then
    echo "ERROR: the setup driver exited ${DRIVER_EXIT}. Full log: ${LOG_FILE}" >&2
    # The log is root-owned (it must be: it is written through this shell's
    # descriptor before sudo drops to odoo), so without this the reason a run
    # failed is readable only by root - while the service that shows the
    # message runs as "cartenz". Echo the tail for whoever reads the reply.
    tail -n 20 "$LOG_FILE" >&2 || true
    exit "$DRIVER_EXIT"
fi
