#!/usr/bin/env bash
# shellcheck shell=bash
#
# Stage: templates — full-installation template databases (ADR-045, OPT-IN).
#
# Runs build-odoo-templates.sh for ODOO_SERIES so every new project's database
# is duplicated from a full installation instead of `-i base`. This is the
# slow step: a full enterprise install commonly takes 20-60 minutes. It is
# deliberately not part of the default run.
#
# Requires the odoo stage to have produced a checkout (or adopted one) and a
# Python runtime that can import that Odoo.

step "templates: building for Odoo $ODOO_SERIES"

BUILDER="$INSTALLER_ROOT/infrastructure/provisioning/build-odoo-templates.sh"
[ -f "$BUILDER" ] || fail "build-odoo-templates.sh not found at $BUILDER"

VERSION_DIR="$ODOO_ROOT/versions/$ODOO_SERIES"
BASE_PATH="$VERSION_DIR/odoo"
ENTERPRISE_PATH="$VERSION_DIR/enterprise"
PYTHON_BIN="${ODOO_PYTHON:-$VERSION_DIR/venv/bin/python}"

if [ ! -f "$BASE_PATH/odoo-bin" ]; then
  fail "$BASE_PATH has no odoo-bin — run the odoo stage first"
fi
if [ ! -x "$PYTHON_BIN" ]; then
  fail "$PYTHON_BIN does not exist — set ODOO_PYTHON to the interpreter for Odoo $ODOO_SERIES"
fi

if pg_role_exists "$ODOO_GROUP"; then
  ok "role $ODOO_GROUP exists"
else
  fail "the '$ODOO_GROUP' Postgres role does not exist — the odoo stage creates the system user, not the role; create it and re-run"
fi

TEMPLATE_CHECK="cartenz_tpl_${ODOO_SERIES/./_}_ent"
if pg_database_exists "$TEMPLATE_CHECK"; then
  skip "template databases already exist (found $TEMPLATE_CHECK) — delete them to rebuild"
else
  if [ "${DRY_RUN:-0}" = "1" ]; then
    printf '    \033[2mwould run:\033[0m %s %s %s %s %s\n' \
      "$BUILDER" "$ODOO_SERIES" "$BASE_PATH" "$PYTHON_BIN" "${ENTERPRISE_PATH:+$ENTERPRISE_PATH}"
  else
    info "this runs a full Odoo install twice (community + enterprise) and can take an hour"
    if [ -d "$ENTERPRISE_PATH" ]; then
      "$BUILDER" "$ODOO_SERIES" "$BASE_PATH" "$PYTHON_BIN" "$ENTERPRISE_PATH"
    else
      "$BUILDER" "$ODOO_SERIES" "$BASE_PATH" "$PYTHON_BIN"
    fi
    ok "templates built"
  fi
fi

summary "templates: full-installation databases for Odoo $ODOO_SERIES"
