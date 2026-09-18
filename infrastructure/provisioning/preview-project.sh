#!/usr/bin/env bash
set -Eeuo pipefail

# ============================================================
# LinkedERP - ephemeral Odoo preview for a task's draft (ADR-052)
# ============================================================
#
# Runs as root via the narrow sudoers rule in
# infrastructure/provisioning/99-linkederp-provisioning, called by the platform
# (backend/src/modules/projects/project-preview.service.ts) when a reviewer asks
# to see a task's draft in a real Odoo before approving it.
#
# A preview is built from durable artefacts, not a live workspace: the platform
# releases a task's workspace the moment a run suspends for an approval, so the
# draft is reconstructed by cloning the target branch at the task's base commit
# and applying the task's retained patch.
#
# Usage:
#   preview-project start <project_name> <ref>
#   preview-project stop  <project_name> <ref>
#
# The job file and patch are read from a FIXED staging directory
# (PREVIEW_STAGING_DIR), never from an argument:
#
#   ${PREVIEW_STAGING_DIR}/<ref>.json    what to build (version, branch, ...)
#   ${PREVIEW_STAGING_DIR}/<ref>.patch   the retained draft
#
# The optional git credential is read from stdin, exactly as pull-project.sh
# reads it, and never appears in argv or in `ps`.
#
# Host configuration (adapt to your host) -------------------------------------
ODOO_VERSIONS_DIR="${ODOO_VERSIONS_DIR:-/opt/odoo/versions}"
PROJECTS_DIR="${PROJECTS_DIR:-/opt/odoo/projects}"
PREVIEW_STAGING_DIR="${PREVIEW_STAGING_DIR:-/opt/cartenz/preview-staging}"
ODOO_USER="${ODOO_USER:-odoo}"
PLATFORM_GROUP="cartenz"
BASE_DOMAIN="${PREVIEW_BASE_DOMAIN:-}"
# ----------------------------------------------------------------------------

usage() {
    echo
    echo "Usage:"
    echo "  preview-project start <project_name> <ref>"
    echo "  preview-project stop  <project_name> <ref>"
    echo
    exit 1
}

fail() { echo "ERROR: $*" >&2; exit 1; }

if [[ "$EUID" -ne 0 ]]; then
    echo "ERROR: This script must be run as root." >&2
    exit 1
fi

if [[ $# -ne 3 ]]; then
    usage
fi

ACTION="$1"
PROJECT_NAME="$2"
REF="$3"

case "$ACTION" in
    start | stop) ;;
    *) fail "Unknown action '${ACTION}'. Expected 'start' or 'stop'." ;;
esac

if [[ ! "$PROJECT_NAME" =~ ^[a-z0-9][a-z0-9_-]{1,30}$ ]]; then
    fail "Invalid project name: '${PROJECT_NAME}'."
fi

# The ref names a directory, a systemd unit and a database. Nothing but a plain
# lowercase token is allowed.
if [[ ! "$REF" =~ ^[a-z0-9]{16}$ ]]; then
    fail "Invalid preview reference: '${REF}'."
fi

PROJECT_DIR="${PROJECTS_DIR}/${PROJECT_NAME}"
PREVIEW_ROOT="${PROJECT_DIR}/preview/${REF}"
SERVICE_NAME="odoo-preview-${REF}"
DB_NAME="cz_prev_${REF}"

# --- stop --------------------------------------------------------------------
#
# Idempotent, and safe to run when only part of a preview was built: each step
# ignores "already gone".

if [[ "$ACTION" == "stop" ]]; then
    systemctl stop "$SERVICE_NAME" 2>/dev/null || true
    systemctl disable "$SERVICE_NAME" 2>/dev/null || true
    rm -f "/etc/systemd/system/${SERVICE_NAME}.service"

    if [[ -n "$BASE_DOMAIN" ]]; then
        rm -f "/etc/nginx/sites-enabled/preview-${REF}"
        rm -f "/etc/nginx/sites-available/preview-${REF}"
        nginx -t >/dev/null 2>&1 && systemctl reload nginx >/dev/null 2>&1 || true
    fi

    systemctl daemon-reload 2>/dev/null || true

    sudo -u postgres dropdb --if-exists "$DB_NAME" 2>/dev/null || true

    if [[ -d "$PREVIEW_ROOT" ]]; then
        rm -rf "$PREVIEW_ROOT"
    fi

    rm -f "${PREVIEW_STAGING_DIR}/${REF}.json" "${PREVIEW_STAGING_DIR}/${REF}.patch"

    echo "OK: preview ${REF} stopped."
    exit 0
fi

# --- start: read the job -----------------------------------------------------

JOB="${PREVIEW_STAGING_DIR}/${REF}.json"
PATCH="${PREVIEW_STAGING_DIR}/${REF}.patch"

[[ -f "$JOB" ]] || fail "Job file not found: ${JOB}"
[[ -f "$PATCH" ]] || fail "Patch file not found: ${PATCH}"

command -v python3 >/dev/null 2>&1 || fail "python3 is required to read the job file."

mapfile -t JOB_FIELDS < <(python3 - "$JOB" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print(d.get("port", ""))
print(d.get("geventPort", ""))
print(d.get("version", ""))
print(d.get("edition", ""))
print(d.get("region", ""))
print(d.get("branch", ""))
print(d.get("baseCommit") or "")
print(",".join(d.get("modules") or []))
print(d.get("repositoryUrl") or "")
PY
)

PORT="${JOB_FIELDS[0]:-}"
GEVENT_PORT="${JOB_FIELDS[1]:-}"
VERSION="${JOB_FIELDS[2]:-}"
EDITION="${JOB_FIELDS[3]:-}"
REGION="${JOB_FIELDS[4]:-}"
BRANCH="${JOB_FIELDS[5]:-}"
BASE_COMMIT="${JOB_FIELDS[6]:-}"
MODULES="${JOB_FIELDS[7]:-}"
REPOSITORY_URL="${JOB_FIELDS[8]:-}"

[[ "$PORT" =~ ^[0-9]+$ ]] || fail "Invalid port '${PORT}' in the job file."
[[ "$GEVENT_PORT" =~ ^[0-9]+$ ]] || fail "Invalid gevent port in the job file."
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+$ ]] || fail "Invalid Odoo version '${VERSION}'."
[[ "$EDITION" == "community" || "$EDITION" == "enterprise" ]] || fail "Invalid edition '${EDITION}'."
case "${REGION//-/_}" in
    indonesia | south_africa | india) REGION_TOKEN="${REGION//-/_}" ;;
    *) fail "Invalid region '${REGION}'." ;;
esac
[[ -z "$REPOSITORY_URL" || "$REPOSITORY_URL" =~ ^https://[A-Za-z0-9._~%:@/+-]+$ || "$REPOSITORY_URL" =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[A-Za-z0-9._/-]+$ ]] \
    || fail "Unsupported repository URL."
[[ -z "$MODULES" || "$MODULES" =~ ^[a-z0-9_]+(,[a-z0-9_]+)*$ ]] || fail "Invalid module list."
[[ -z "$BRANCH" || "$BRANCH" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$ ]] || fail "Invalid branch."

ODOO_BASE="${ODOO_VERSIONS_DIR}/${VERSION}/odoo"
ODOO_ENTERPRISE="${ODOO_VERSIONS_DIR}/${VERSION}/enterprise"
VER_MAJOR="${VERSION%%.*}"
ODOO_PYTHON="${ODOO_VERSIONS_DIR}/venv${VER_MAJOR}/bin/python"

[[ -f "${ODOO_BASE}/odoo-bin" ]] || fail "Odoo ${VERSION} is not installed at ${ODOO_BASE}."

# --- database: clone the standard template -----------------------------------

VER_TAG="${VERSION/./_}"
TEMPLATE_SUFFIX="com"
[[ "$EDITION" == "enterprise" ]] && TEMPLATE_SUFFIX="ent"

template_exists() {
    sudo -u postgres psql -tAc \
        "SELECT 1 FROM pg_database WHERE datname = '$1' AND datistemplate" | grep -q 1
}

TEMPLATE="cartenz_tpl_${VER_TAG}_${TEMPLATE_SUFFIX}_${REGION_TOKEN}"
if ! template_exists "$TEMPLATE"; then
    TEMPLATE="cartenz_tpl_${VER_TAG}_${TEMPLATE_SUFFIX}"
fi
template_exists "$TEMPLATE" \
    || fail "No template database for ${VERSION} ${EDITION} ${REGION_TOKEN}. Build one with build-standard-template.sh."

# --- code: clone the branch and apply the retained draft ---------------------

sudo -u postgres dropdb --if-exists "$DB_NAME" 2>/dev/null || true
rm -rf "$PREVIEW_ROOT"
mkdir -p "${PREVIEW_ROOT}/addons" "${PREVIEW_ROOT}/config" "${PREVIEW_ROOT}/data" "${PREVIEW_ROOT}/logs"
chown -R "${ODOO_USER}:${ODOO_USER}" "$PREVIEW_ROOT"
chmod 750 "$PREVIEW_ROOT"

ADDONS_DIR="${PREVIEW_ROOT}/addons"

# Credential from stdin, exactly as pull-project.sh handles it, so a token never
# reaches argv or `ps`.
CREDENTIAL=""
if [[ ! -t 0 ]]; then
    CREDENTIAL="$(cat || true)"
    CREDENTIAL="${CREDENTIAL%%$'\n'*}"
fi

SECRET_DIR=""
cleanup() {
    [[ -n "$SECRET_DIR" && -d "$SECRET_DIR" ]] && rm -rf "$SECRET_DIR"
}
trap cleanup EXIT

GIT_ENV=(-u GIT_CONFIG_GLOBAL -u GIT_CONFIG_SYSTEM -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE)

if [[ "$REPOSITORY_URL" == http* ]]; then
    if [[ -n "$CREDENTIAL" ]]; then
        SECRET_DIR="$(mktemp -d /tmp/preview-project-XXXXXX)"
        chmod 0700 "$SECRET_DIR"
        chown "$ODOO_USER" "$SECRET_DIR"
        TOKEN_FILE="${SECRET_DIR}/token"
        printf '%s' "$CREDENTIAL" > "$TOKEN_FILE"
        chmod 0600 "$TOKEN_FILE"
        chown "$ODOO_USER" "$TOKEN_FILE"
        ASKPASS_FILE="${SECRET_DIR}/askpass"
        printf '#!/usr/bin/env bash\ncat "$GIT_CREDENTIAL_FILE"\n' > "$ASKPASS_FILE"
        chmod 0700 "$ASKPASS_FILE"
        chown "$ODOO_USER" "$ASKPASS_FILE"
        GIT_ENV+=(-u GIT_TERMINAL_PROMPT GIT_TERMINAL_PROMPT=0 GIT_ASKPASS="$ASKPASS_FILE" GIT_CREDENTIAL_FILE="$TOKEN_FILE")
    else
        GIT_ENV+=(GIT_TERMINAL_PROMPT=0)
    fi
else
    GIT_ENV+=(GIT_TERMINAL_PROMPT=0)
    if [[ -n "$CREDENTIAL" ]]; then
        [[ -f "$CREDENTIAL" ]] || fail "SSH key not found: ${CREDENTIAL}"
        GIT_ENV+=(GIT_SSH_COMMAND="ssh -i ${CREDENTIAL} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new")
    else
        GIT_ENV+=(GIT_SSH_COMMAND="ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new")
    fi
fi

run_git() {
    sudo -u "$ODOO_USER" -H env "${GIT_ENV[@]}" \
        git -C "$ADDONS_DIR" \
        -c core.hooksPath=/dev/null \
        -c safe.directory="$ADDONS_DIR" \
        "$@"
}

if [[ -n "$REPOSITORY_URL" ]]; then
    run_git init --quiet
    run_git remote add origin "$REPOSITORY_URL"
    run_git fetch --prune --quiet origin "${BRANCH:-main}"

    if [[ -n "$BASE_COMMIT" ]]; then
        run_git checkout --quiet "$BASE_COMMIT"
    else
        run_git checkout --quiet -B "${BRANCH:-main}" FETCH_HEAD
    fi

    # The patch is read by the odoo user, so it is copied in with that owner and
    # mode, applied, then removed.
    DRAFT="${PREVIEW_ROOT}/draft.patch"
    install -o "$ODOO_USER" -g "$ODOO_USER" -m 0600 "$PATCH" "$DRAFT"
    sudo -u "$ODOO_USER" -H git -C "$ADDONS_DIR" apply --whitespace=nowarn "$DRAFT" \
        || fail "The draft patch did not apply cleanly to ${BASE_COMMIT:-$BRANCH}."
    rm -f "$DRAFT"
else
    # No repository: the preview shows the standard baseline with no draft code.
    touch "${ADDONS_DIR}/.gitkeep"
fi

# --- database: clone, neutralise, update the changed modules -----------------

sudo -u postgres createdb -O "$ODOO_USER" -T "$TEMPLATE" "$DB_NAME"
sudo -u postgres psql -v ON_ERROR_STOP=1 -q \
    -c "UPDATE pg_database SET datallowconn = true WHERE datname = '${DB_NAME}';"
sudo -u postgres psql -v ON_ERROR_STOP=1 -q -d "$DB_NAME" \
    -c "UPDATE ir_config_parameter SET value = gen_random_uuid() WHERE key = 'database.uuid';"

PREVIEW_URL="http://127.0.0.1:${PORT}"
TOKEN=""
if [[ -n "$BASE_DOMAIN" ]]; then
    TOKEN="$(openssl rand -hex 16)"
    PREVIEW_URL="http://preview-${REF}.${BASE_DOMAIN}/?token=${TOKEN}"
    sudo -u postgres psql -v ON_ERROR_STOP=1 -q -d "$DB_NAME" \
        -c "UPDATE ir_config_parameter SET value = '${PREVIEW_URL}' WHERE key = 'web.base.url';"
fi

ADDONS_PATH="${ADDONS_DIR},${ODOO_BASE}/addons"
[[ "$EDITION" == "enterprise" && -d "$ODOO_ENTERPRISE" ]] && ADDONS_PATH="${ODOO_ENTERPRISE},${ADDONS_PATH}"

CONF="${PREVIEW_ROOT}/config/odoo.conf"
cat > "$CONF" <<EOF
[options]
addons_path = ${ADDONS_PATH}
db_name = ${DB_NAME}
db_host = 127.0.0.1
db_port = 5432
db_user = ${ODOO_USER}
http_interface = 127.0.0.1
http_port = ${PORT}
gevent_port = ${GEVENT_PORT}
data_dir = ${PREVIEW_ROOT}/data
logfile = ${PREVIEW_ROOT}/logs/odoo.log
list_db = False
EOF
chown "${ODOO_USER}:${ODOO_USER}" "$CONF"
chmod 640 "$CONF"

if [[ -n "$MODULES" ]]; then
    echo "Updating modules: ${MODULES}"
    sudo -u "$ODOO_USER" -H "$ODOO_PYTHON" "${ODOO_BASE}/odoo-bin" \
        -c "$CONF" -d "$DB_NAME" -u "$MODULES" \
        --without-demo=all --stop-after-init --no-http \
        --logfile "${PREVIEW_ROOT}/logs/update.log" \
        || fail "A module failed to update; see ${PREVIEW_ROOT}/logs/update.log."
fi

# --- run it ------------------------------------------------------------------

cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=Odoo preview ${REF}
After=network.target postgresql.service

[Service]
Type=simple
User=${ODOO_USER}
Group=${ODOO_USER}
ExecStart=${ODOO_PYTHON} ${ODOO_BASE}/odoo-bin -c ${CONF}
Restart=on-failure
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
EOF

if [[ -n "$BASE_DOMAIN" ]]; then
    cat > "/etc/nginx/sites-available/preview-${REF}" <<EOF
server {
    listen 80;
    server_name preview-${REF}.${BASE_DOMAIN};

    # The preview serves client code; a token is required and only the reviewer
    # who asked for it holds the link.
    if (\$arg_token != "${TOKEN}") { return 403; }

    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300s;
    }
}
EOF
    ln -sf "/etc/nginx/sites-available/preview-${REF}" "/etc/nginx/sites-enabled/preview-${REF}"
fi

systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}.service" >/dev/null
if [[ -n "$BASE_DOMAIN" ]]; then
    nginx -t >/dev/null 2>&1 && systemctl reload nginx >/dev/null 2>&1 || true
fi

echo "PREVIEW URL: ${PREVIEW_URL}"
echo "PREVIEW DATABASE: ${DB_NAME}"
echo "OK: preview ${REF} is running."
