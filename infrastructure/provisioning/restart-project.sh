#!/usr/bin/env bash
set -Eeuo pipefail

# ============================================================
# LinkedERP - upgrade and restart a project's Odoo instance
# ============================================================
#
# Runs as root via the narrow sudoers rule in
# infrastructure/provisioning/99-linkederp-provisioning, called by the platform
# (backend/src/modules/projects/project-deployment.service.ts, restart()) when
# an operator asks for a project's instance to be brought onto a branch's tip
# AND serve it (ADR-057).
#
# pull-project.sh resets addons/ on disk. That alone is not enough: a new
# field, a changed view or a migration is invisible until Odoo runs `-u`
# against the instance's database, and new Python is not loaded until the
# systemd unit restarts. This script does both, in the order that keeps the
# database from being upgraded out from under a running Odoo:
#
#   1. record the commit the instance is serving right now
#   2. stop the unit
#   3. pull (by calling pull-project.sh as a subprocess, not by duplicating it)
#   4. odoo-bin -u all --stop-after-init   (apply the upgrade)
#   5a. on success: start the unit, poll is-active, report
#   5b. on failure: reset addons/ back to the commit from step 1, start the
#       unit, report — the instance always ends this script serving *something*,
#       never left stopped with a half-applied database.
#
# Usage:
#   restart-project <project_name> <repository_url> <branch>
#
# Same three-argument shape as pull-project.sh, and the same stdin credential
# convention (one line, optional, never in argv):
#
#   echo "$TOKEN" | restart-project ggroma https://github.com/owner/repo.git main
#
# Exit code 0 means the instance is up and serving what was asked. Non-zero
# means either the upgrade failed and was rolled back (stdout has a line
# starting "ROLLEDBACK:<commit>" before the error — the platform reads this to
# tell "rolled back, unharmed" apart from "may be half-upgraded"), or something
# failed before the point of no return (the pull itself, or the stop), in which
# case there is nothing to roll back because nothing was changed yet.
#
# ============================================================

BASE_DIR="/opt/odoo"
PROJECTS_DIR="${BASE_DIR}/projects"
ODOO_USER="odoo"
VENV_PYTHON="${BASE_DIR}/venv/bin/python"
ODOO_BIN="${BASE_DIR}/odoo-server/odoo-bin"
PULL_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PULL_SCRIPT="${PULL_SCRIPT_DIR}/pull-project.sh"
# The service-readiness poll below mirrors create_project's own post-start
# check: a unit that is merely "started" and one that is actually serving are
# not the same thing, and Restart=always papers over a crash loop just long
# enough to look like success to a caller that does not wait.
START_POLL_ATTEMPTS=10
START_POLL_INTERVAL_S=2

usage() {
    echo
    echo "Usage:"
    echo "  restart-project <project_name> <repository_url> <branch>"
    echo
    echo "  Reads an optional HTTPS token or SSH key path from stdin."
    echo
    exit 1
}

if [[ "$EUID" -ne 0 ]]; then
    echo "ERROR: This script must be run as root." >&2
    exit 1
fi

if [[ $# -ne 3 ]]; then
    usage
fi

PROJECT_NAME="$1"
REPOSITORY_URL="$2"
BRANCH="$3"

# --- Argument validation -----------------------------------------------------
#
# Same shape assertProvisioningInvocation enforces on the platform side, and
# the same regexes pull-project.sh checks — this script hands the same three
# arguments straight through to it. Both gates exist on purpose: this one must
# hold even when the script is run by hand.

if [[ ! "$PROJECT_NAME" =~ ^[a-z0-9][a-z0-9_-]{1,30}$ ]]; then
    echo "ERROR: Invalid project name: '${PROJECT_NAME}'." >&2
    exit 1
fi

if [[ ! "$BRANCH" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$ ]]; then
    echo "ERROR: Invalid branch name: '${BRANCH}'." >&2
    exit 1
fi

if [[ ! "$REPOSITORY_URL" =~ ^https://[A-Za-z0-9._~%:@/+-]+$ ]] \
    && [[ ! "$REPOSITORY_URL" =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[A-Za-z0-9._/-]+$ ]]; then
    echo "ERROR: Unsupported repository URL: '${REPOSITORY_URL}'." >&2
    echo "       Only https:// and scp-style (git@host:owner/repo.git) remotes are accepted." >&2
    exit 1
fi

PROJECT_DIR="${PROJECTS_DIR}/${PROJECT_NAME}"
ADDONS_DIR="${PROJECT_DIR}/addons"
CONFIG_FILE="${PROJECT_DIR}/config/odoo.conf"
SERVICE_NAME="odoo-${PROJECT_NAME}"
LOG_FILE="/tmp/cartenz-restart-${PROJECT_NAME}.log"

if [[ ! -f "$PULL_SCRIPT" ]]; then
    echo "ERROR: pull-project.sh not found beside this script at ${PULL_SCRIPT}." >&2
    exit 1
fi

if [[ ! -d "$PROJECT_DIR" ]]; then
    echo "ERROR: Project directory does not exist: ${PROJECT_DIR}" >&2
    exit 1
fi

if [[ ! -f "$CONFIG_FILE" ]]; then
    echo "ERROR: Odoo config not found: ${CONFIG_FILE}" >&2
    exit 1
fi

if ! systemctl list-unit-files "${SERVICE_NAME}.service" | grep -q "${SERVICE_NAME}.service"; then
    echo "ERROR: systemd unit ${SERVICE_NAME}.service does not exist." >&2
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

# The database name lives in odoo.conf as create_project writes it; read it
# back rather than assuming it equals the project name, which create_project
# does not always guarantee for older projects.
DB_NAME="$(sed -n 's/^\s*db_name\s*=\s*//p' "$CONFIG_FILE" | head -1 | tr -d '[:space:]')"
if [[ -z "$DB_NAME" ]]; then
    echo "ERROR: Could not read db_name from ${CONFIG_FILE}." >&2
    exit 1
fi

# --- Credential, read from stdin, forwarded to pull-project.sh unread -------
#
# This script never inspects the credential itself; it exists only to pass it
# through to pull-project.sh exactly as a caller of that script directly would.
CREDENTIAL=""
if [[ ! -t 0 ]]; then
    CREDENTIAL="$(cat || true)"
fi

run_git() {
    sudo -u "$ODOO_USER" -H env -u GIT_CONFIG_GLOBAL -u GIT_CONFIG_SYSTEM -u GIT_DIR \
        -u GIT_WORK_TREE -u GIT_INDEX_FILE GIT_TERMINAL_PROMPT=0 \
        git -C "$ADDONS_DIR" -c core.hooksPath=/dev/null -c safe.directory="$ADDONS_DIR" "$@"
}

wait_for_active() {
    local attempt
    for ((attempt = 1; attempt <= START_POLL_ATTEMPTS; attempt++)); do
        if systemctl is-active --quiet "$SERVICE_NAME"; then
            return 0
        fi
        sleep "$START_POLL_INTERVAL_S"
    done
    return 1
}

# --- 1. Record the current commit, before anything changes ------------------

PREVIOUS_COMMIT=""
if [[ -d "${ADDONS_DIR}/.git" ]]; then
    PREVIOUS_COMMIT="$(run_git rev-parse HEAD 2>/dev/null || true)"
fi

# --- 2. Stop the unit, before the pull and before the upgrade ---------------
#
# Before, not after: a running Odoo holds open connections and row locks on the
# very tables the upgrade alters, and an `-u all` racing the live service is
# how an upgrade deadlocks or half-applies.

echo "Stopping ${SERVICE_NAME}..."
systemctl stop "$SERVICE_NAME"

# --- 3. Pull, by calling pull-project.sh as a subprocess ---------------------
#
# Not duplicated, not refactored: that script is production-critical and
# already tested on real projects. Its own validation, its stdin-credential
# handling and its ownership fix-up (the setgid re-establishment) all apply
# unchanged when called this way.

echo "Pulling ${PROJECT_NAME} @ ${BRANCH}..."
if [[ -n "$CREDENTIAL" ]]; then
    printf '%s' "$CREDENTIAL" | "$PULL_SCRIPT" "$PROJECT_NAME" "$REPOSITORY_URL" "$BRANCH"
else
    "$PULL_SCRIPT" "$PROJECT_NAME" "$REPOSITORY_URL" "$BRANCH"
fi

# --- 4. Upgrade every installed module against the instance's database ------
#
# -u all, the operator's explicit choice: simpler and certain to pick up every
# changed module, at the cost of a slower upgrade than naming just the changed
# ones. --stop-after-init: this run applies the upgrade and exits, it does not
# stay up serving requests — step 5 starts the always-on unit separately.

echo "Upgrading ${DB_NAME} (this can take a while)..."
if sudo -u "$ODOO_USER" "$VENV_PYTHON" "$ODOO_BIN" \
    -c "$CONFIG_FILE" -d "$DB_NAME" -u all --stop-after-init --no-http \
    > "$LOG_FILE" 2>&1; then

    # --- 5a. Success: start the unit and confirm it is actually serving -----

    echo "Starting ${SERVICE_NAME}..."
    systemctl start "$SERVICE_NAME"

    if ! wait_for_active; then
        echo "ERROR: ${SERVICE_NAME} did not become active after the upgrade." >&2
        echo "       Check: systemctl status ${SERVICE_NAME}" >&2
        exit 1
    fi

    COMMIT="$(run_git rev-parse HEAD)"
    echo "OK: ${PROJECT_NAME} is now serving ${BRANCH} @ ${COMMIT}"
else
    # --- 5b. Failure: roll the code back, start the unit on what it had -----
    #
    # The instance is already stopped and the new code is already on disk, so
    # "leaving it as it was" is not a state that exists by itself — it has to
    # be reassembled. Never left to a caller to notice by absence.

    echo "ERROR: Upgrade failed. Rolling back and restarting on the previous code." >&2
    echo "       Full log: ${LOG_FILE} (readable via the worker's private /tmp)." >&2

    if [[ -n "$PREVIOUS_COMMIT" ]]; then
        run_git reset --hard --quiet "$PREVIOUS_COMMIT"
        echo "ROLLEDBACK: ${PREVIOUS_COMMIT}"
    else
        echo "       No previous commit was on record; addons/ left as the pull now has it." >&2
    fi

    systemctl start "$SERVICE_NAME" || true

    if [[ -n "$PREVIOUS_COMMIT" ]] && ! wait_for_active; then
        echo "ERROR: rolled back, but ${SERVICE_NAME} did not become active. Check the unit by hand." >&2
    fi

    exit 1
fi
