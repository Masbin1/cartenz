#!/usr/bin/env bash
# shellcheck shell=bash
#
# Stage: cartenz — the platform itself.
#
# Application code, .env (generated once, never overwritten), PostgreSQL role
# and database, build, migrations, systemd units. This is the core the other
# stages orbit: hermes wires into its .env, provisioning reads its sudoers
# rule, templates build against the estate the odoo stage prepared.

step "cartenz: application code"

if [ -f "$INSTALL_ROOT/package.json" ]; then
  skip "already deployed at $INSTALL_ROOT"
elif [ "$INSTALLER_ROOT" = "$INSTALL_ROOT" ]; then
  skip "running from $INSTALL_ROOT"
elif [ -n "$REPO_URL" ]; then
  info "cloning $REPO_URL"
  run sudo -u "$SERVICE_USER" git clone "$REPO_URL" "$INSTALL_ROOT"
  ok "cloned"
else
  info "copying $INSTALLER_ROOT -> $INSTALL_ROOT"
  # node_modules and build output are rebuilt below; .git and .env are not
  # copied, so a checkout used for staging cannot leak its secrets here.
  run rsync -a \
    --exclude node_modules --exclude .git --exclude .env \
    --exclude 'backend/dist' --exclude 'frontend/.next' --exclude '.runtime' \
    "$INSTALLER_ROOT/" "$INSTALL_ROOT/"
  ok "copied"
fi

run chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_ROOT"

step "cartenz: configuration"

GENERATED_DB_PASSWORD=""

if [ -f "$INSTALL_ROOT/.env" ]; then
  skip ".env exists — not overwritten (SECRETS_ROOT_KEY must survive)"
else
  run sudo -u "$SERVICE_USER" bash "$INSTALL_ROOT/infrastructure/scripts/bootstrap-env.sh"

  if [ -z "$DB_PASSWORD" ]; then
    DB_PASSWORD="$(openssl rand -hex 24)"
    GENERATED_DB_PASSWORD="$DB_PASSWORD"
  fi

  if [ "${DRY_RUN:-0}" != "1" ]; then
    # Production settings the bootstrap template does not know about. Written
    # with sed on the generated file rather than appended, so the file keeps
    # one entry per variable.
    sed -i \
      -e "s|^NODE_ENV=.*|NODE_ENV=production|" \
      -e "s|^DATABASE_URL=.*|DATABASE_URL=postgresql://${DB_USER}:${DB_PASSWORD}@localhost:5432/${DB_NAME}|" \
      -e "s|^REDIS_URL=.*|REDIS_URL=redis://localhost:6379/0|" \
      -e "s|^WORKSPACE_ROOT=.*|WORKSPACE_ROOT=${INSTALL_ROOT}/.runtime/workspaces|" \
      -e "s|^GIT_PUSH_ENABLED=.*|GIT_PUSH_ENABLED=false|" \
      -e "s|^VALIDATION_ENABLED=.*|VALIDATION_ENABLED=false|" \
      "$INSTALL_ROOT/.env"
    chmod 600 "$INSTALL_ROOT/.env"
    chown "$SERVICE_USER:$SERVICE_USER" "$INSTALL_ROOT/.env"
  fi
  ok "wrote .env (mode 600)"
  info "GIT_PUSH_ENABLED=false and VALIDATION_ENABLED=false — review before enabling"
fi

step "cartenz: database"

if [ "${SKIP_DATABASE:-0}" = "1" ]; then
  skip "SKIP_DATABASE=1"
elif [ "${DRY_RUN:-0}" = "1" ]; then
  printf '    \033[2mwould run:\033[0m CREATE ROLE %s / CREATE DATABASE %s\n' "$DB_USER" "$DB_NAME"
else
  # Read the password back from .env rather than trusting the variable: on a
  # re-run the file is the authority, and the role may already exist with it.
  ENV_DB_URL="$(env_get DATABASE_URL "$INSTALL_ROOT/.env")"
  ENV_DB_PASSWORD="$(printf '%s' "$ENV_DB_URL" | sed -E 's#.*://[^:]+:([^@]+)@.*#\1#')"

  # A non-matching sed returns its input unchanged, so an empty check is not
  # enough: a URL carrying no password would otherwise be used *as* the
  # password, and the role would be created with a credential nobody knows.
  if [ -z "$ENV_DB_PASSWORD" ] || [ "$ENV_DB_PASSWORD" = "$ENV_DB_URL" ]; then
    fail "DATABASE_URL in $INSTALL_ROOT/.env has no password in the form postgresql://user:password@host:port/db"
  fi

  if pg_role_exists "$DB_USER"; then
    skip "role $DB_USER exists"
  else
    su postgres -s /bin/sh -c "psql -q" <<SQL
CREATE ROLE ${DB_USER} WITH LOGIN PASSWORD '${ENV_DB_PASSWORD}';
SQL
    ok "created role $DB_USER"
  fi

  if pg_database_exists "$DB_NAME"; then
    skip "database $DB_NAME exists"
  else
    su postgres -s /bin/sh -c "psql -q" <<SQL
CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};
SQL
    ok "created database $DB_NAME"
  fi
fi

step "cartenz: build and migrate"

run sudo -u "$SERVICE_USER" bash -c "cd '$INSTALL_ROOT' && npm ci --silent"
ok "dependencies installed"

run sudo -u "$SERVICE_USER" bash -c "cd '$INSTALL_ROOT' && npm run build"
ok "backend and portal built"

run sudo -u "$SERVICE_USER" bash -c "cd '$INSTALL_ROOT' && npm run db:migrate"
ok "migrations applied"

step "cartenz: systemd units"

for unit in "$UNIT_SOURCE"/*.service; do
  name="$(basename "$unit")"
  run install -m 0644 "$unit" "/etc/systemd/system/$name"
  info "$name"
done

run systemctl daemon-reload

# Which units to start is decided by what exists: the gateway unit must not be
# enabled when its ExecStart is missing, or the service loops on restart.
UNITS="cartenz-api cartenz-worker cartenz-portal"
if [ -e "$GATEWAY_LINK" ] || [ "${DRY_RUN:-0}" = "1" ]; then
  UNITS="9router $UNITS"
else
  warn "9router not installed — its unit is left disabled (§5 of the install guide)"
fi

# shellcheck disable=SC2086
run systemctl enable $UNITS
# shellcheck disable=SC2086
run systemctl restart $UNITS
ok "enabled and started: $UNITS"

step "cartenz: log rotation"

if [ -f /etc/logrotate.d/cartenz ]; then
  skip "/etc/logrotate.d/cartenz exists"
elif [ "${DRY_RUN:-0}" = "1" ]; then
  printf '    \033[2mwould write:\033[0m /etc/logrotate.d/cartenz\n'
else
  cat > /etc/logrotate.d/cartenz <<'EOF'
/var/log/cartenz/*.log {
  daily
  rotate 14
  compress
  missingok
  notifempty
  copytruncate
}
EOF
  ok "/etc/logrotate.d/cartenz"
fi

step "cartenz: verify"

if [ "${DRY_RUN:-0}" = "1" ]; then
  skip "dry run"
else
  API_PORT="$(env_get API_PORT "$INSTALL_ROOT/.env")"
  API_PORT="${API_PORT:-4000}"

  READY=""
  for _ in $(seq 1 20); do
    READY="$(curl -fsS -m 3 "http://127.0.0.1:${API_PORT}/api/v1/health/ready" 2>/dev/null || true)"
    case "$READY" in *'"status":"ready"'*) break ;; esac
    sleep 2
  done

  for unit in $UNITS; do
    state="$(systemctl is-active "$unit" 2>/dev/null || true)"
    if [ "$state" = "active" ]; then ok "$unit active"; else warn "$unit is $state"; fi
  done

  case "$READY" in
    *'"status":"ready"'*) ok "health/ready: $READY" ;;
    *) warn "health/ready did not report ready. Check journalctl -u cartenz-api" ;;
  esac
fi

if [ -n "$GENERATED_DB_PASSWORD" ]; then
  warn "A database password was generated and written to .env."
  info "It is not printed here. Read it with: sudo grep DATABASE_URL $INSTALL_ROOT/.env"
fi

summary "cartenz: platform at $INSTALL_ROOT, database $DB_NAME, units ${UNITS}"
