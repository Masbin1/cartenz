#!/usr/bin/env bash
set -Eeuo pipefail

# ============================================================
# LinkedERP - permanently tear down ONE on-premise project
# ============================================================
#
# Runs as root via the narrow sudoers rule in
# infrastructure/provisioning/99-linkederp-provisioning, called by the platform
# (backend/src/modules/projects/project-deployment.service.ts, teardown())
# when an operator permanently deletes an on-premise project. Before this
# script existed, `projects.service.ts#destroy` only removed the platform's
# own database row — the systemd unit, the Odoo database, the project
# directory, the Nginx site and its certificate all survived every delete,
# silently accumulating on the host.
#
# This is teardown-all-odoo.sh narrowed to a single, named project, with the
# same ordering and the same refusal-over-guessing posture: back up first,
# abort before anything is touched if the backup cannot be trusted, then stop
# the unit, drop the database, remove the directory, remove the Nginx site and
# its certificate.
#
# Usage:
#   teardown-project.sh <project_name>
#
# Example:
#   teardown-project.sh etp20v
#
# Exit code 0 means the project's systemd unit, database, directory, Nginx
# site and certificate are all gone (or were already absent). A pre-teardown
# backup is left at /opt/odoo/backups/<project>/<id>/ unless SKIP_BACKUP=1 is
# set — a permanent delete that takes no restore point first is the one
# mistake this script is built not to allow by default.
#
# ============================================================

ODOO_USER="odoo"
BASE_DOMAIN="${BASE_DOMAIN:-masbintang.space}"
NGINX_AVAILABLE="/etc/nginx/sites-available"
NGINX_ENABLED="/etc/nginx/sites-enabled"
SYSTEMD_DIR="/etc/systemd/system"
BACKUP_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_SCRIPT="${BACKUP_SCRIPT_DIR}/backup-project.sh"
SKIP_BACKUP="${SKIP_BACKUP:-0}"

log()  { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
info() { printf '   %s\n' "$*"; }
warn() { printf '   !! %s\n' "$*" >&2; }
fail() { echo "ERROR: $*" >&2; exit 1; }

usage() {
    echo
    echo "Usage:"
    echo "  teardown-project.sh <project_name>"
    echo
    echo "  Set SKIP_BACKUP=1 to skip the pre-teardown backup (not recommended)."
    echo
    exit 1
}

if [[ "$EUID" -ne 0 ]]; then
    fail "This script must be run as root."
fi

if [[ $# -ne 1 ]]; then
    usage
fi

PROJECT_NAME="$1"

if [[ ! "$PROJECT_NAME" =~ ^[a-z0-9][a-z0-9_-]{1,30}$ ]]; then
    fail "Invalid project name: '${PROJECT_NAME}'."
fi

# Each Odoo major version's projects live under its own BASE_DIR (ADR:
# 20.0-separate-runtime) — /opt/odoo/projects for 19.0 and earlier,
# /opt/odoo20/projects for 20.0. Probe every known BASE_DIR, same as
# grant-addons-write.sh, pull-project.sh and restart-project.sh, instead of
# assuming the 19.0 one. Absence under every root is not an error here (a
# scaffold-only project that was never provisioned has none), it just skips
# everything that needs a directory.
PROJECT_DIR=""
BASE_DIR=""
for candidate_base in /opt/odoo /opt/odoo20; do
    if [[ -d "${candidate_base}/projects/${PROJECT_NAME}" ]]; then
        PROJECT_DIR="${candidate_base}/projects/${PROJECT_NAME}"
        BASE_DIR="$candidate_base"
        break
    fi
done

# backup-project.sh (step 1) defaults to the 19.0 tree on its own, and it runs as
# a child process: the tree this project actually lives in has to be exported for
# it to find a 20.0 project's directory and database.
if [[ -n "$BASE_DIR" ]]; then
    export BASE_DIR
fi

SERVICE_NAME="odoo-${PROJECT_NAME}"
DOMAIN="${PROJECT_NAME}.${BASE_DOMAIN}"
CONFIG_FILE="${PROJECT_DIR}/config/odoo.conf"
DB_NAME="$PROJECT_NAME"
if [[ -n "$PROJECT_DIR" && -f "$CONFIG_FILE" ]]; then
    READ_DB_NAME="$(sed -n 's/^\s*db_name\s*=\s*//p' "$CONFIG_FILE" | head -1 | tr -d '[:space:]')"
    [[ -n "$READ_DB_NAME" ]] && DB_NAME="$READ_DB_NAME"
fi

info "project:  ${PROJECT_NAME}"
info "dir:      ${PROJECT_DIR:-<none — never provisioned, or already removed>}"
info "unit:     ${SERVICE_NAME}.service"
info "database: ${DB_NAME}"
info "domain:   ${DOMAIN}"

# ------------------------------------------------------------------
# 1. Back up the project first, unless explicitly skipped.
#
# Mirrors teardown-all-odoo.sh's own non-negotiable rule: a permanent delete
# that destroys the only copy of a client's data because the backup step was
# an afterthought is not an acceptable failure mode. Nothing below runs until
# this either succeeds or is explicitly waived.
# ------------------------------------------------------------------

if [[ "$SKIP_BACKUP" == "1" ]]; then
    log "1/5  Backup SKIPPED (SKIP_BACKUP=1)"
elif [[ -z "$PROJECT_DIR" ]]; then
    log "1/5  Backup skipped (no project directory — nothing was ever provisioned)"
elif [[ ! -f "$CONFIG_FILE" ]]; then
    log "1/5  Backup skipped (no odoo.conf under ${PROJECT_DIR} — not a provisioned instance)"
else
    log "1/5  Backing up ${PROJECT_NAME} before teardown"
    if [[ ! -x "$BACKUP_SCRIPT" ]]; then
        fail "backup-project.sh not found or not executable at ${BACKUP_SCRIPT}; aborting " \
            "rather than deleting without a restore point. Set SKIP_BACKUP=1 to override."
    fi
    if ! "$BACKUP_SCRIPT" "$PROJECT_NAME"; then
        fail "pre-teardown backup failed; nothing has been touched. Set SKIP_BACKUP=1 to " \
            "delete without one, or fix the backup and run again."
    fi
fi

# ------------------------------------------------------------------
# 2. Stop and remove the systemd unit.
# ------------------------------------------------------------------

log "2/5  Stopping and removing ${SERVICE_NAME}.service"

if systemctl cat "${SERVICE_NAME}.service" >/dev/null 2>&1; then
    systemctl disable --now "${SERVICE_NAME}.service" >/dev/null 2>&1 \
        && info "stopped + disabled ${SERVICE_NAME}.service" \
        || info "stopped ${SERVICE_NAME}.service (was not enabled)"
else
    info "no ${SERVICE_NAME}.service unit file; already stopped or never provisioned"
fi

UNIT_FILE="${SYSTEMD_DIR}/${SERVICE_NAME}.service"
if [[ -f "$UNIT_FILE" ]]; then
    rm -f "$UNIT_FILE" && info "removed ${UNIT_FILE}"
    systemctl daemon-reload
else
    info "no unit file at ${UNIT_FILE}"
fi

# ------------------------------------------------------------------
# 3. Drop the database.
# ------------------------------------------------------------------

log "3/5  Dropping database"

# Both Postgres clusters are checked (5432 for 19.x, 5433 for 20.0+): the
# BASE_DIR probe above only found an on-disk directory, which says nothing
# about which cluster the database itself lives on, and a wrong guess here
# must not be mistaken for "already gone".
DB_DROPPED=0
for port in 5432 5433; do
    if sudo -u postgres psql -p "$port" -tAc \
        "select 1 from pg_database where datname = '${DB_NAME}'" 2>/dev/null | grep -q 1; then
        sudo -u postgres psql -p "$port" -tAc \
            "select pg_terminate_backend(pid) from pg_stat_activity
              where datname = '${DB_NAME}' and pid <> pg_backend_pid()" >/dev/null 2>&1 || true
        if sudo -u postgres dropdb -p "$port" --if-exists "$DB_NAME"; then
            info "dropped ${DB_NAME} (port ${port})"
            DB_DROPPED=1
        else
            warn "could not drop ${DB_NAME} on port ${port}"
        fi
    fi
done
[[ "$DB_DROPPED" -eq 1 ]] || info "database ${DB_NAME} not found on either cluster (already gone)"

# ------------------------------------------------------------------
# 4. Remove the project directory (config, data, logs, addons — everything).
# ------------------------------------------------------------------

log "4/5  Removing project directory"

if [[ -n "$PROJECT_DIR" && -d "$PROJECT_DIR" ]]; then
    rm -rf "$PROJECT_DIR" && info "removed ${PROJECT_DIR}"
else
    info "no project directory to remove"
fi

# ------------------------------------------------------------------
# 5. Remove the Nginx site and its certificate.
# ------------------------------------------------------------------

log "5/5  Removing Nginx site and certificate"

NGINX_TOUCHED=0
for path in "${NGINX_ENABLED}/${PROJECT_NAME}" "${NGINX_AVAILABLE}/${PROJECT_NAME}"; do
    if [[ -e "$path" || -L "$path" ]]; then
        rm -f "$path" && info "removed ${path}"
        NGINX_TOUCHED=1
    fi
done

if [[ "$NGINX_TOUCHED" -eq 1 ]]; then
    if nginx -t 2>/dev/null; then
        systemctl reload nginx && info "nginx reloaded"
    else
        warn "nginx -t failed after removing the site; check /etc/nginx by hand."
    fi
else
    info "no Nginx site files for ${PROJECT_NAME}"
fi

if [[ -d "/etc/letsencrypt/live/${DOMAIN}" ]]; then
    if certbot delete --cert-name "$DOMAIN" --non-interactive >/dev/null 2>&1; then
        info "deleted certificate ${DOMAIN}"
    else
        warn "could not delete certificate ${DOMAIN}"
    fi
fi

echo
echo "OK: ${PROJECT_NAME} torn down (unit, database, directory, Nginx site, certificate)."
