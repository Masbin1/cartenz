#!/usr/bin/env bash
# shellcheck shell=bash
#
# Stage: provisioning — the pieces that turn a created project into a running
# Odoo instance (ADR-039/040/045).
#
#   - the sudoers rule, installed to the exact path the platform's allow-list
#     names (validated with visudo -cf first)
#   - the operator scripts (create_project, create_project_enterprise,
#     create-project-db.sh, grant-addons-write.sh, setup-project-https.sh)
#   - the projects directory (one project directory per created project)
#   - the Odoo paths in .env (base, enterprise, python, provisioning scripts)

step "provisioning: sudoers rule"

SUDOERS_SOURCE="$INSTALLER_ROOT/infrastructure/provisioning/99-linkederp-provisioning"
SUDOERS_TARGET=/etc/sudoers.d/99-linkederp-provisioning

if [ ! -f "$SUDOERS_SOURCE" ]; then
  warn "no sudoers rule in the repository; project provisioning will need it installed by hand"
elif [ -f "$SUDOERS_TARGET" ]; then
  skip "$SUDOERS_TARGET exists — left alone (it may carry host-specific paths)"
elif [ "${DRY_RUN:-0}" = "1" ]; then
  printf '    \033[2mwould validate and install:\033[0m %s\n' "$SUDOERS_TARGET"
elif ! visudo -cf "$SUDOERS_SOURCE" >/dev/null; then
  warn "$SUDOERS_SOURCE failed visudo -cf; NOT installed — fix it and re-run"
else
  run install -o root -g root -m 0440 "$SUDOERS_SOURCE" "$SUDOERS_TARGET"
  ok "$SUDOERS_TARGET (project provisioning: sudo -n without a password)"
fi

step "provisioning: operator scripts"

run mkdir -p "$PROVISIONING_SCRIPTS_DIR"

for script in create_project create_project_enterprise create-project-db.sh grant-addons-write.sh setup-project-https.sh pull-project.sh preview-project.sh; do
  SRC="$INSTALLER_ROOT/infrastructure/provisioning/$script"
  if [ ! -f "$SRC" ]; then
    warn "$script not in the repository — skipped"
    continue
  fi
  if cmp -s "$SRC" "$PROVISIONING_SCRIPTS_DIR/$script"; then
    skip "$script unchanged"
  else
    # The create scripts carry the host configuration block at the top
    # (ODOO_BASE, BASE_DOMAIN, ...). They are copied verbatim on first
    # install; afterwards they are the operator's to edit and never
    # overwritten — a later re-run must not clobber a changed base domain.
    if [ -f "$PROVISIONING_SCRIPTS_DIR/$script" ]; then
      info "$script exists with local changes — left alone"
    else
      run install -o root -g root -m 0755 "$SRC" "$PROVISIONING_SCRIPTS_DIR/$script"
      ok "installed $script"
    fi
  fi
done

if [ -x "$PROVISIONING_SCRIPTS_DIR/create_project" ]; then
  ok "provisioning scripts live at $PROVISIONING_SCRIPTS_DIR"
else
  warn "no create_project script present — the sudoers rule is inert until it is"
fi

step "provisioning: projects directory"

run mkdir -p "$PROJECTS_DIR"
run chown "$ODOO_GROUP:$ODOO_GROUP" "$PROJECTS_DIR"
ok "$PROJECTS_DIR (owned by $ODOO_GROUP)"

step "provisioning: preview staging directory"

# Where the platform writes a preview's job file and patch for the root-run
# preview-project.sh to read (ADR-052). Owned by the service user, mode 700: the
# draft patch is customer source for the life of the build. Must match
# PROJECT_PREVIEW_STAGING_DIR in .env.
PREVIEW_STAGING_DIR="${PROJECT_PREVIEW_STAGING_DIR:-/opt/cartenz/preview-staging}"
run mkdir -p "$PREVIEW_STAGING_DIR"
run chown "$SERVICE_USER:$SERVICE_USER" "$PREVIEW_STAGING_DIR"
run chmod 700 "$PREVIEW_STAGING_DIR"
ok "$PREVIEW_STAGING_DIR (owned by $SERVICE_USER)"

step "provisioning: Odoo paths in .env"

CARTENZ_ENV="$INSTALL_ROOT/.env"
if [ "${DRY_RUN:-0}" = "1" ]; then
  info "would set ODOO_SOURCE_PATHS, ODOO_PYTHON, ON_PREMISE_ROOT and the provisioning scripts in $CARTENZ_ENV"
else
  [ -f "$CARTENZ_ENV" ] || fail "$CARTENZ_ENV not found — did the cartenz stage run before this one?"

  # The paths are the environment fallback (ADR-031/033): the portal is the
  # authority once an operator fills it in, and until then the agent reads
  # what is written here.
  upsert_env "$CARTENZ_ENV" "$SERVICE_USER" 600 ODOO_SOURCE_PATHS \
    "$ODOO_ROOT/versions/$ODOO_SERIES/odoo,$([ -d "$ODOO_ROOT/versions/$ODOO_SERIES/enterprise" ] && echo "$ODOO_ROOT/versions/$ODOO_SERIES/enterprise")"

  if [ -n "$ODOO_PYTHON" ]; then
    upsert_env "$CARTENZ_ENV" "$SERVICE_USER" 600 ODOO_PYTHON "$ODOO_PYTHON"
  fi

  upsert_env "$CARTENZ_ENV" "$SERVICE_USER" 600 ON_PREMISE_ROOT "$PROJECTS_DIR"
  upsert_env "$CARTENZ_ENV" "$SERVICE_USER" 600 PROJECT_PROVISION_SCRIPT \
    "$PROVISIONING_SCRIPTS_DIR/create_project"
  upsert_env "$CARTENZ_ENV" "$SERVICE_USER" 600 PROJECT_PROVISION_SCRIPT_ENTERPRISE \
    "$PROVISIONING_SCRIPTS_DIR/create_project_enterprise"
  upsert_env "$CARTENZ_ENV" "$SERVICE_USER" 600 PROJECT_PROVISION_GRANT_SCRIPT \
    "$PROVISIONING_SCRIPTS_DIR/grant-addons-write.sh"
  upsert_env "$CARTENZ_ENV" "$SERVICE_USER" 600 PROJECT_PROVISION_PROJECTS_DIR "$PROJECTS_DIR"

  run systemctl restart cartenz-api cartenz-worker || \
    warn "restart cartenz-api/worker manually to apply the path changes"
  ok "paths written (PROJECT_PROVISIONING_ENABLED stays false until the operator opts in)"
fi

summary "provisioning: scripts at $PROVISIONING_SCRIPTS_DIR, projects at $PROJECTS_DIR"
