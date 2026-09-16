#!/usr/bin/env bash
#
# LinkedERP Cartenz — single installer for a fresh server (ADR-048).
#
#   sudo ./infrastructure/install/install.sh
#
# One entry point that installs the whole estate, from an empty Ubuntu/Debian
# host to a running platform, in this order:
#
#   base         system packages, Node.js, PostgreSQL, Redis, service account
#   odoo         the Odoo estate per version (installed, or adopted when present)
#   gateway      9router model gateway
#   hermes       Hermes agent — OPT-IN, it is heavy (see below)
#   cartenz      platform code, .env, database, build, migrations, systemd units
#   provisioning the sudoers rule, operator scripts, projects root
#   templates    full-installation template databases — OPT-IN (20-60 minutes)
#
# Odoo is auto-detected: a version directory that already holds odoo-bin is
# adopted (read-only to the platform) rather than installed over.
#
# Usage:
#
#   sudo ./install.sh                        everything except the opt-ins
#   sudo ./install.sh --with hermes          add the Hermes agent
#   sudo ./install.sh --with templates       add template databases (slow)
#   sudo ./install.sh --with hermes,templates
#   sudo ./install.sh --skip odoo,templates  run only the rest
#   sudo ./install.sh --only cartenz         re-run one stage
#   sudo ./install.sh --dry-run              print the plan, change nothing
#
# Configuration: everything is read from the environment, or from
# install.conf when it exists next to this script. Copy install.conf.example
# and edit it; the file is the record of what this host runs.
#
# Re-running is safe: every stage checks for what it is about to create and
# skips it. Two things are never overwritten — the platform .env
# (SECRETS_ROOT_KEY must survive, ADR-014) and an existing database.
#
set -euo pipefail

# ── find the library and the stages ───────────────────────────────────────────

SELF_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
INSTALL_DIR="$(dirname "$SELF_PATH")"

# shellcheck source=lib/common.sh
. "$INSTALL_DIR/lib/common.sh"
# shellcheck source=lib/env.sh
. "$INSTALL_DIR/lib/env.sh"

# ── stage selection ───────────────────────────────────────────────────────────
# Parsed before preflight so --help and an unknown flag answer without needing
# root, and so --dry-run is known by the time preflight reports it.

ALL_STAGES=(base odoo gateway hermes cartenz provisioning templates)
# Heavy or optional by nature; excluded from the default run unless --with names them.
OPT_IN=(hermes templates)

# The default run is everything except the opt-ins.
SELECTED=()
for stage in "${ALL_STAGES[@]}"; do
  is_opt_in=0
  for opt in "${OPT_IN[@]}"; do [ "$opt" = "$stage" ] && is_opt_in=1; done
  [ "$is_opt_in" = "0" ] && SELECTED+=("$stage")
done

while [ $# -gt 0 ]; do
  case "$1" in
    --with)
      [ $# -ge 2 ] || fail "--with needs a comma-separated list of stages"
      for stage in ${2//,/ }; do SELECTED+=("$stage"); done
      shift 2
      ;;
    --skip)
      [ $# -ge 2 ] || fail "--skip needs a comma-separated list of stages"
      # Exact-name removal: substring substitution would corrupt a name that
      # contains another (and silently drop the wrong stage).
      for stage in ${2//,/ }; do
        KEPT=()
        for have in "${SELECTED[@]}"; do
          [ "$have" = "$stage" ] || KEPT+=("$have")
        done
        SELECTED=("${KEPT[@]}")
      done
      shift 2
      ;;
    --only)
      [ $# -ge 2 ] || fail "--only needs a comma-separated list of stages"
      SELECTED=()
      for stage in ${2//,/ }; do SELECTED+=("$stage"); done
      shift 2
      ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help)
      sed -n '3,40p' "$SELF_PATH" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) fail "unknown argument: $1 (see --help)" ;;
  esac
done

# De-duplicate while keeping order, and drop empties left by --skip.
UNIQ=()
for stage in "${SELECTED[@]}"; do
  [ -z "$stage" ] && continue
  seen=0
  for have in "${UNIQ[@]}"; do [ "$have" = "$stage" ] && seen=1; done
  [ "$seen" = "0" ] && UNIQ+=("$stage")
done
SELECTED=("${UNIQ[@]}")

for stage in "${SELECTED[@]}"; do
  found=0
  for known in "${ALL_STAGES[@]}"; do [ "$known" = "$stage" ] && found=1; done
  [ "$found" = "1" ] || fail "unknown stage: $stage (known: ${ALL_STAGES[*]})"
done

[ ${#SELECTED[@]} -gt 0 ] || fail "no stages selected"

# ── configuration: install.conf, then the environment ─────────────────────────
# The environment wins over the file, so a one-off run can override a knob
# without editing the record: ODOO_SERIES=18.0 sudo ./install.sh --skip odoo

if [ -f "$INSTALL_DIR/install.conf" ]; then
  info "reading $INSTALL_DIR/install.conf"
  # shellcheck disable=SC1090
  . "$INSTALL_DIR/install.conf"
fi

# shellcheck source=lib/preflight.sh
. "$INSTALL_DIR/lib/preflight.sh"

# ── run ───────────────────────────────────────────────────────────────────────

heading "LinkedERP Cartenz installer"
info "stages: ${SELECTED[*]}"
info "root: $INSTALL_ROOT   user: $SERVICE_USER   odoo: $ODOO_ROOT"

export INSTALLER_ROOT INSTALL_DIR INSTALL_ROOT SERVICE_USER LOG_DIR DRY_RUN
export DB_NAME DB_USER DB_PASSWORD REPO_URL NODE_MAJOR
export ODOO_ROOT ODOO_SERIES ODOO_GROUP ODOO_PYTHON
export GATEWAY_LINK HERMES_HOME_DIR HERMES_SRC HERMES_ENV HERMES_REPO HERMES_REF HERMES_PORT HERMES_MODEL_KEYS_FILE
export PROVISIONING_SCRIPTS_DIR PROJECTS_DIR UNIT_SOURCE

for stage in "${SELECTED[@]}"; do
  SCRIPT="$INSTALL_DIR/stages/${stage}.sh"
  [ -f "$SCRIPT" ] || fail "stage file missing: $SCRIPT"
  # Each stage is its own process with the shared library, so one failing stage
  # stops the run (set -e) without leaving state the next stage would trip on.
  # shellcheck source=/dev/null
  . "$SCRIPT"
done

print_summary

heading "Done"
info "stages completed: ${SELECTED[*]}"
info "log directory: $LOG_DIR"
info "guide: $INSTALLER_ROOT/docs/INSTALL-SERVER.md"
