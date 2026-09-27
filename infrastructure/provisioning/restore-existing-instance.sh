#!/usr/bin/env bash
set -Eeuo pipefail

# ============================================================
# LinkedERP - restore an odoo.sh backup zip into a NEW Cartenz-owned instance
# (ADR-067)
# ============================================================
#
# Connecting an existing odoo.sh project never reaches the customer's own
# instance (ADR-050). Instead an operator downloads a backup from odoo.sh (the
# standard zip: dump.sql + filestore/ + manifest.json), places it in one fixed
# staging directory, and this script builds a brand-new Odoo on THIS host
# from it:
#
#   1. a project directory, systemd unit and database of its own
#   2. optionally, the project's repository at the given branch in addons/
#      (via pull-project.sh, unchanged, credential on stdin) so the
#      customer's own modules are on the addons path when the registry first
#      loads
#   3. `odoo-bin db load --neutralize` - Odoo's own loader for this exact zip
#      format; neutralization (mail servers off, crons off, webhooks off,
#      database.secret replaced) happens before the registry ever starts, so
#      no cron or outgoing mail can fire from real customer data
#   4. the unit is started, bound to 127.0.0.1 only, with no Nginx site
#
# The instance is for a human to look at. The AI agent never works against it:
# nothing records it as the project's onPremisePath, and a task keeps running
# against the project's standard, template-built database (ADR-050 §3).
#
# The zip is never accepted as a path. It is looked up by basename inside
# STAGING_DIR, so no argument can make this script read a file elsewhere.
#
# Usage:
#   restore-existing-instance.sh <instance_name> <http_port> <zip_filename> \
#       [<repository_url> <branch>]
#
#   Reads an optional HTTPS token or SSH key path from stdin (only used when a
#   repository is given), exactly like pull-project.sh.
#
# Example:
#   restore-existing-instance.sh dodol-stg 7010 dodol-staging.zip \
#       git@github.com:acme/dodol.git staging
# ============================================================

BASE_DIR="/opt/odoo"
PROJECTS_DIR="${PROJECTS_DIR:-${BASE_DIR}/projects}"
STAGING_DIR="${RESTORE_STAGING_DIR:-/opt/cartenz/restore-staging}"
ODOO_USER="${ODOO_USER:-odoo}"
ODOO_BASE_PATH="${ODOO_BASE_PATH:-/opt/odoo/odoo-server}"
ODOO_ENTERPRISE_PATH="${ODOO_ENTERPRISE_PATH:-/opt/odoo/enterprise}"
ODOO_PYTHON="${ODOO_PYTHON:-/opt/odoo/venv/bin/python}"
SYSTEMD_DIR="/etc/systemd/system"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PULL_SCRIPT="${SCRIPT_DIR}/pull-project.sh"
START_POLL_ATTEMPTS=15
START_POLL_INTERVAL_S=2

usage() {
    echo
    echo "Usage:"
    echo "  restore-existing-instance.sh <instance_name> <http_port> <zip_filename> [<repository_url> <branch>]"
    echo
    echo "  <zip_filename> must already exist at ${STAGING_DIR}/<zip_filename>."
    echo
    exit 1
}

fail() { echo "ERROR: $*" >&2; exit 1; }

if [[ "${EUID}" -ne 0 ]]; then
    fail "This script must be run as root."
fi

if [[ $# -ne 3 && $# -ne 5 ]]; then
    usage
fi

INSTANCE_NAME="$1"
HTTP_PORT="$2"
ZIP_FILENAME="$3"
REPOSITORY_URL="${4:-}"
BRANCH="${5:-}"

if [[ ! "$INSTANCE_NAME" =~ ^[a-z0-9][a-z0-9_-]{1,30}$ ]]; then
    fail "Invalid instance name '${INSTANCE_NAME}'."
fi

if [[ ! "$HTTP_PORT" =~ ^[0-9]+$ ]] || (( HTTP_PORT < 1024 || HTTP_PORT > 65534 )); then
    fail "HTTP port must be numeric, between 1024 and 65534."
fi

# Basename only: no separator, no leading dot, no "..", a .zip suffix. This is
# the whole defence against being pointed outside STAGING_DIR.
if [[ ! "$ZIP_FILENAME" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.zip$ ]] \
    || [[ "$ZIP_FILENAME" == *"/"* ]] || [[ "$ZIP_FILENAME" == *".."* ]]; then
    fail "Invalid backup filename '${ZIP_FILENAME}'."
fi

if [[ -n "$REPOSITORY_URL" ]]; then
    if [[ ! "$BRANCH" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$ ]]; then
        fail "Invalid branch name: '${BRANCH}'."
    fi
    if [[ ! "$REPOSITORY_URL" =~ ^https://[A-Za-z0-9._~%:@/+-]+$ ]] \
        && [[ ! "$REPOSITORY_URL" =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[A-Za-z0-9._/-]+$ ]]; then
        fail "Unsupported repository URL: '${REPOSITORY_URL}'."
    fi
    [[ -f "$PULL_SCRIPT" ]] || fail "pull-project.sh not found beside this script at ${PULL_SCRIPT}."
fi

REAL_STAGING_DIR="$(realpath -m "$STAGING_DIR")"
ZIP_PATH="$(realpath -m "${STAGING_DIR}/${ZIP_FILENAME}")"
[[ "$ZIP_PATH" == "${REAL_STAGING_DIR}/"* ]] \
    || fail "Refusing '${ZIP_FILENAME}': it does not resolve inside ${STAGING_DIR}."
[[ -f "$ZIP_PATH" && ! -L "${STAGING_DIR}/${ZIP_FILENAME}" ]] \
    || fail "No backup file at ${ZIP_PATH}. Copy the odoo.sh zip there first."

PROJECT_DIR="${PROJECTS_DIR}/${INSTANCE_NAME}"
CONFIG_DIR="${PROJECT_DIR}/config"
ADDONS_DIR="${PROJECT_DIR}/addons"
DATA_DIR="${PROJECT_DIR}/data"
LOG_DIR="${PROJECT_DIR}/logs"
CONFIG_FILE="${CONFIG_DIR}/odoo.conf"
SERVICE_NAME="odoo-${INSTANCE_NAME}"
SERVICE_FILE="${SYSTEMD_DIR}/${SERVICE_NAME}.service"
DB_NAME="$INSTANCE_NAME"

[[ -x "$ODOO_PYTHON" ]] || fail "Odoo venv Python not found or not executable: ${ODOO_PYTHON}"
[[ -x "${ODOO_BASE_PATH}/odoo-bin" ]] || fail "odoo-bin not found: ${ODOO_BASE_PATH}/odoo-bin"
[[ -e "$PROJECT_DIR" ]] && fail "Project directory already exists: ${PROJECT_DIR}"
[[ -e "$SERVICE_FILE" ]] && fail "Systemd service already exists: ${SERVICE_FILE}"
if ss -ltn | awk '{print $4}' | grep -qE ":${HTTP_PORT}\$"; then
    fail "HTTP port ${HTTP_PORT} is already in use."
fi
if sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'" | grep -q 1; then
    fail "PostgreSQL database '${DB_NAME}' already exists."
fi

# --- the zip is an Odoo backup, for this host's Odoo series ------------------
# Checked before anything is created: a 17.0 dump loaded into a 19.0 server
# fails deep inside the registry load, after minutes of psql, with an error
# that does not name the real cause.
unzip -tqq "$ZIP_PATH" >/dev/null 2>&1 || fail "'${ZIP_FILENAME}' is not a readable zip file."
unzip -l "$ZIP_PATH" dump.sql >/dev/null 2>&1 \
    || fail "'${ZIP_FILENAME}' has no dump.sql; is it an odoo.sh/database-manager backup (zip with filestore)?"

HOST_SERIES="$(sed -nE 's/^version_info = \(([0-9]+), ([0-9]+).*/\1.\2/p' "${ODOO_BASE_PATH}/odoo/release.py" | head -1)"
DUMP_SERIES="$(unzip -p "$ZIP_PATH" manifest.json 2>/dev/null \
    | python3 -c 'import json,sys
try:
    m = json.load(sys.stdin)
except Exception:
    sys.exit(0)
print(m.get("major_version") or ".".join(str(v) for v in (m.get("version_info") or [])[:2]))' \
    || true)"
# odoo.sh uses "saas~18.3"-style series for SaaS builds; keep the numeric tail.
DUMP_SERIES="${DUMP_SERIES##*~}"
if [[ -n "$DUMP_SERIES" && -n "$HOST_SERIES" && "$DUMP_SERIES" != "$HOST_SERIES" ]]; then
    fail "The backup is Odoo ${DUMP_SERIES}, but this host runs Odoo ${HOST_SERIES}. Restore into a matching version, or upgrade the database first."
fi
[[ -z "$DUMP_SERIES" ]] && echo "WARN: the zip has no readable manifest.json; the Odoo version could not be checked." >&2

CREATED_PROJECT=false
CREATED_DB=false
CREATED_SERVICE=false
WORK_DIR=""

cleanup() {
    local exit_code=$?
    [[ -n "$WORK_DIR" ]] && rm -rf "$WORK_DIR"
    if (( exit_code == 0 )); then
        return
    fi
    echo "ERROR: restore failed; cleaning up." >&2
    systemctl stop "$SERVICE_NAME" 2>/dev/null || true
    systemctl disable "$SERVICE_NAME" 2>/dev/null || true
    [[ "$CREATED_SERVICE" == true ]] && rm -f "$SERVICE_FILE"
    # db load creates the database itself, so a failure part-way can leave one
    # behind even though CREATED_DB was never set: drop by name either way. The
    # name was checked not to exist before this run, so it is ours.
    sudo -u postgres dropdb --if-exists "$DB_NAME" 2>/dev/null || true
    [[ "$CREATED_PROJECT" == true ]] && rm -rf "$PROJECT_DIR"
    systemctl daemon-reload 2>/dev/null || true
    exit "$exit_code"
}
trap cleanup EXIT

echo "Creating project directories..."
mkdir -p "$CONFIG_DIR" "$ADDONS_DIR" "$DATA_DIR" "$LOG_DIR"
chown -R "${ODOO_USER}:${ODOO_USER}" "$PROJECT_DIR"
chmod 750 "$PROJECT_DIR" "$CONFIG_DIR" "$ADDONS_DIR" "$DATA_DIR" "$LOG_DIR"
CREATED_PROJECT=true

if [[ -n "$REPOSITORY_URL" ]]; then
    echo "Checking out ${REPOSITORY_URL} @ ${BRANCH} into addons/..."
    CREDENTIAL=""
    if [[ ! -t 0 ]]; then
        CREDENTIAL="$(cat || true)"
    fi
    if [[ -n "$CREDENTIAL" ]]; then
        printf '%s' "$CREDENTIAL" | "$PULL_SCRIPT" "$INSTANCE_NAME" "$REPOSITORY_URL" "$BRANCH"
    else
        "$PULL_SCRIPT" "$INSTANCE_NAME" "$REPOSITORY_URL" "$BRANCH" </dev/null
    fi
fi

ADDONS_PATH="${ODOO_BASE_PATH}/addons"
[[ -d "$ODOO_ENTERPRISE_PATH" ]] && ADDONS_PATH="${ODOO_ENTERPRISE_PATH},${ADDONS_PATH}"
# addons/ only goes on the path when it holds at least one module: Odoo skips
# an empty directory with a warning, but a checkout whose modules sit one
# level down (odoo.sh submodules) is added per sub-directory.
if compgen -G "${ADDONS_DIR}/*/__manifest__.py" >/dev/null; then
    ADDONS_PATH="${ADDONS_PATH},${ADDONS_DIR}"
fi
while IFS= read -r -d '' sub; do
    compgen -G "${sub}/*/__manifest__.py" >/dev/null && ADDONS_PATH="${ADDONS_PATH},${sub}"
done < <(find "$ADDONS_DIR" -mindepth 1 -maxdepth 1 -type d ! -name '.*' -print0 2>/dev/null)

# restore_db reads the zip as the odoo user, which cannot read the staging
# directory; hand it a private copy rather than loosening that directory.
WORK_DIR="$(mktemp -d /var/tmp/cartenz-restore-XXXXXX)"
chown "$ODOO_USER" "$WORK_DIR"
chmod 700 "$WORK_DIR"
install -o "$ODOO_USER" -m 0600 "$ZIP_PATH" "${WORK_DIR}/backup.zip"

echo "Loading '${ZIP_FILENAME}' into '${DB_NAME}' and neutralizing (this can take a while)..."
LOAD_LOG="${LOG_DIR}/restore.log"
set +e
sudo -u "$ODOO_USER" -H env TMPDIR="$WORK_DIR" "$ODOO_PYTHON" "${ODOO_BASE_PATH}/odoo-bin" \
    db -D "$DATA_DIR" --addons-path "$ADDONS_PATH" \
    load --neutralize "$DB_NAME" "${WORK_DIR}/backup.zip" \
    > "$LOAD_LOG" 2>&1
LOAD_EXIT=$?
set -e
chown "${ODOO_USER}:${ODOO_USER}" "$LOAD_LOG" 2>/dev/null || true

if (( LOAD_EXIT != 0 )); then
    echo "ERROR: loading '${ZIP_FILENAME}' failed (exit ${LOAD_EXIT}). Last lines:" >&2
    tail -n 30 "$LOAD_LOG" >&2 || true
    exit "$LOAD_EXIT"
fi
CREATED_DB=true
rm -rf "$WORK_DIR"
WORK_DIR=""

# Belt and braces: `load --neutralize` sets this flag itself. Refuse to start
# an instance on real data that does not carry it.
NEUTRALIZED="$(sudo -u postgres psql -tAq -d "$DB_NAME" \
    -c "SELECT value FROM ir_config_parameter WHERE key = 'database.is_neutralized'" | tr -d '[:space:]')"
[[ "$NEUTRALIZED" == "True" || "$NEUTRALIZED" == "true" ]] \
    || fail "The restored database is not marked neutralized; refusing to start it."
echo "OK: database '${DB_NAME}' restored and neutralized."

# The master password guards the database manager, which is off here
# (list_db = False). It is generated so the config never holds a default, and
# deliberately not printed: nothing on the platform needs it.
MASTER_PASSWORD="$(openssl rand -hex 32)"

cat > "$CONFIG_FILE" <<EOF
[options]
admin_passwd = ${MASTER_PASSWORD}
http_interface = 127.0.0.1
http_port = ${HTTP_PORT}
db_user = ${ODOO_USER}
db_name = ${DB_NAME}
dbfilter = ^${DB_NAME}\$
list_db = False
addons_path = ${ADDONS_PATH}
data_dir = ${DATA_DIR}
; One process and no cron thread: this is a look-only copy on a small host,
; and the neutralized database has its crons off anyway.
workers = 0
max_cron_threads = 0
limit_time_cpu = 600
limit_time_real = 1200
logfile = ${LOG_DIR}/odoo.log
log_level = info
EOF
chown root:"$ODOO_USER" "$CONFIG_FILE"
chmod 640 "$CONFIG_FILE"

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Odoo restored copy - ${INSTANCE_NAME} (ADR-067)
After=network.target postgresql.service
Requires=postgresql.service
[Service]
Type=simple
User=${ODOO_USER}
Group=${ODOO_USER}
WorkingDirectory=${ODOO_BASE_PATH}
ExecStart=${ODOO_PYTHON} ${ODOO_BASE_PATH}/odoo-bin -c ${CONFIG_FILE}
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
KillMode=mixed
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=${PROJECT_DIR}
StandardOutput=journal
StandardError=journal
[Install]
WantedBy=multi-user.target
EOF
chmod 644 "$SERVICE_FILE"
CREATED_SERVICE=true
systemctl daemon-reload

echo "Starting ${SERVICE_NAME}..."
systemctl enable --now "$SERVICE_NAME" >/dev/null 2>&1
STARTED=false
for ((attempt = 1; attempt <= START_POLL_ATTEMPTS; attempt++)); do
    if systemctl is-active --quiet "$SERVICE_NAME" \
        && ss -ltn | awk '{print $4}' | grep -qE ":${HTTP_PORT}\$"; then
        STARTED=true
        break
    fi
    sleep "$START_POLL_INTERVAL_S"
done
if [[ "$STARTED" != true ]]; then
    echo "ERROR: ${SERVICE_NAME} did not start listening on ${HTTP_PORT}." >&2
    tail -n 30 "${LOG_DIR}/odoo.log" >&2 2>/dev/null || true
    exit 1
fi

echo "OK: restored instance '${INSTANCE_NAME}' is running on 127.0.0.1:${HTTP_PORT}."
echo "RESTORED_DB=${DB_NAME}"
echo "RESTORED_PORT=${HTTP_PORT}"
echo "RESTORED_SERIES=${DUMP_SERIES:-unknown}"
