#!/usr/bin/env bash
# shellcheck shell=bash
#
# Preflight checks shared by every stage (ADR-048).
#
# Everything that would stop the install is checked before anything is
# changed, so a missing prerequisite does not leave a half-installed host.
# Stages source this; install.sh sources it once before running any stage and
# stages can rely on the facts it establishes.

# Resolves the checkout root and install locations. Sourced, not executed, so
# these are variables the caller keeps.
INSTALLER_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [ "${DRY_RUN:-0}" = "1" ]; then
  warn "DRY_RUN=1 — nothing will be changed."
fi

# Root and systemd are hard requirements; the distribution is a warning because
# Debian-derived systems are the target but nothing here should brick others.
require_root
require_command systemctl "systemd is required: the services are installed as systemd units."

if [ ! -r /etc/os-release ]; then
  fail "Cannot identify the distribution (/etc/os-release is missing)."
fi
# shellcheck disable=SC1091
. /etc/os-release
case "${ID:-}" in
  ubuntu|debian) ok "distribution ${PRETTY_NAME:-$ID}" ;;
  *) warn "This installer targets Ubuntu/Debian. Found '${ID:-unknown}'; apt steps may fail." ;;
esac

# The unit files must be present: without them the install cannot produce a
# running platform, so failing here beats failing at systemctl enable.
UNIT_SOURCE="$INSTALLER_ROOT/infrastructure/systemd"
if [ ! -d "$UNIT_SOURCE" ]; then
  fail "Unit files not found at $UNIT_SOURCE. Run from a Cartenz checkout."
fi
ok "source checkout $INSTALLER_ROOT"

# The default values live in one place so `install.sh --help` and the stages
# agree. Each is overridable through the environment or install.conf.
INSTALL_ROOT="${INSTALL_ROOT:-/opt/cartenz}"
SERVICE_USER="${SERVICE_USER:-cartenz}"
LOG_DIR="${LOG_DIR:-/var/log/cartenz}"

DB_NAME="${DB_NAME:-linkederp_ai}"
DB_USER="${DB_USER:-linkederp}"
DB_PASSWORD="${DB_PASSWORD:-}"
REPO_URL="${REPO_URL:-}"
NODE_MAJOR="${NODE_MAJOR:-22}"

# Odoo estate (stage 10). ODOO_ROOT is the estate root; each version lives
# under ODOO_ROOT/versions/<ver>/{odoo,enterprise}. When a version directory
# already holds odoo-bin the stage adopts it instead of installing.
ODOO_ROOT="${ODOO_ROOT:-/opt/odoo}"
ODOO_SERIES="${ODOO_SERIES:-19.0}"
ODOO_GROUP="${ODOO_GROUP:-odoo}"
ODOO_PYTHON="${ODOO_PYTHON:-}"

# Model gateway and agent (stages 20, 30).
GATEWAY_LINK="${GATEWAY_LINK:-/opt/9router}"
HERMES_HOME_DIR="${HERMES_HOME_DIR:-$INSTALL_ROOT/.hermes}"
HERMES_SRC="${HERMES_SRC:-$HERMES_HOME_DIR/hermes-agent}"
HERMES_ENV="${HERMES_ENV:-$HERMES_HOME_DIR/.env}"
HERMES_REPO="${HERMES_REPO:-https://github.com/NousResearch/hermes-agent.git}"
HERMES_REF="${HERMES_REF:-main}"
HERMES_PORT="${HERMES_PORT:-8642}"
HERMES_MODEL_KEYS_FILE="${HERMES_MODEL_KEYS_FILE:-}"

# Provisioning (stage 50).
PROVISIONING_SCRIPTS_DIR="${PROVISIONING_SCRIPTS_DIR:-$ODOO_ROOT/scripts}"
PROJECTS_DIR="${PROJECTS_DIR:-$ODOO_ROOT/projects}"
