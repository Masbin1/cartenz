#!/usr/bin/env bash
#
# Installs Cartenz on a Linux server: system packages, database, application
# build, systemd units (docs/INSTALL-SERVER.md).
#
#   sudo ./infrastructure/scripts/install-server.sh
#
# Run as root. The platform itself never runs as root — the script creates a
# dedicated `cartenz` account and the units run as that.
#
# The script is idempotent: every step checks for what it is about to create and
# skips it if it is already there, so a re-run after a failure resumes rather
# than duplicating. Nothing is destructive. Two things it will never overwrite:
#
#   - An existing .env. Losing SECRETS_ROOT_KEY makes every stored project
#     credential unrecoverable (ADR-014), so a generated one is written once and
#     then left alone.
#   - An existing database. The migration step is additive and forward-only.
#
# What it does NOT do, because these need a decision rather than a default:
#
#   - TLS and the reverse proxy (§7 of the install guide). The units bind to
#     loopback; putting nginx in front is a deliberate step.
#   - The provider chain. Model providers are configured in the portal by a
#     person who knows which keys the organisation holds (ADR-023).
#   - Odoo validation (§8). It stays disabled, and validation is reported as
#     skipped rather than faked.
#
# Environment overrides:
#
#   INSTALL_ROOT   where the application lives          (default /opt/cartenz)
#   SERVICE_USER   the account the services run as      (default cartenz)
#   DB_NAME        platform database                    (default linkederp_ai)
#   DB_USER        platform role                        (default linkederp)
#   DB_PASSWORD    platform role password               (generated if unset)
#   REPO_URL       clone source when INSTALL_ROOT is empty
#   NODE_MAJOR     Node.js major to install             (default 22)
#   SKIP_PACKAGES  =1 to skip apt installs
#   SKIP_DATABASE  =1 to skip role/database creation
#   DRY_RUN        =1 to print what would happen and change nothing
#
set -euo pipefail

INSTALL_ROOT="${INSTALL_ROOT:-/opt/cartenz}"
SERVICE_USER="${SERVICE_USER:-cartenz}"
DB_NAME="${DB_NAME:-linkederp_ai}"
DB_USER="${DB_USER:-linkederp}"
DB_PASSWORD="${DB_PASSWORD:-}"
REPO_URL="${REPO_URL:-}"
NODE_MAJOR="${NODE_MAJOR:-22}"
SKIP_PACKAGES="${SKIP_PACKAGES:-0}"
SKIP_DATABASE="${SKIP_DATABASE:-0}"
DRY_RUN="${DRY_RUN:-0}"

LOG_DIR=/var/log/cartenz
GATEWAY_LINK=/opt/9router

# ── output ────────────────────────────────────────────────────────────────────

step()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info()  { printf '    %s\n' "$*"; }
skip()  { printf '    \033[2m- %s\033[0m\n' "$*"; }
ok()    { printf '    \033[32mok\033[0m %s\n' "$*"; }
warn()  { printf '    \033[33mwarning\033[0m %s\n' "$*"; }
fail()  { printf '\n\033[31mfailed:\033[0m %s\n' "$*" >&2; exit 1; }

run() {
  if [ "$DRY_RUN" = "1" ]; then
    printf '    \033[2mwould run:\033[0m %s\n' "$*"
  else
    "$@"
  fi
}

# ── preflight ─────────────────────────────────────────────────────────────────
# Everything that would stop the install is checked before anything is changed,
# so a missing prerequisite does not leave a half-installed host.

step "Preflight"

[ "$(id -u)" = "0" ] || fail "Run as root: sudo $0"

if [ ! -r /etc/os-release ]; then
  fail "Cannot identify the distribution (/etc/os-release is missing)."
fi
# shellcheck disable=SC1091
. /etc/os-release
case "${ID:-}" in
  ubuntu|debian) ok "distribution ${PRETTY_NAME:-$ID}" ;;
  *) warn "This script targets Ubuntu/Debian. Found '${ID:-unknown}'; apt steps may fail." ;;
esac

if ! command -v systemctl >/dev/null 2>&1; then
  fail "systemd is required: the services are installed as systemd units."
fi

# The script may run from a checkout that is not yet at INSTALL_ROOT (a fresh
# server clones into place), or from INSTALL_ROOT itself (a re-run).
#
# BASH_SOURCE is resolved to a real path first: invoked through a symlink, or as
# `bash script.sh` from another directory, the naive dirname gives the wrong root
# and the unit files are then looked for somewhere that does not exist.
SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
SOURCE_ROOT="$(cd "$(dirname "$SCRIPT_PATH")/../.." && pwd)"
UNIT_SOURCE="$SOURCE_ROOT/infrastructure/systemd"

if [ ! -d "$UNIT_SOURCE" ]; then
  fail "Unit files not found at $UNIT_SOURCE. Run this from a Cartenz checkout."
fi
ok "source checkout $SOURCE_ROOT"

if [ "$DRY_RUN" = "1" ]; then
  warn "DRY_RUN=1 — nothing will be changed."
fi

# ── 1. packages ───────────────────────────────────────────────────────────────

step "1. System packages"

if [ "$SKIP_PACKAGES" = "1" ]; then
  skip "SKIP_PACKAGES=1"
else
  run apt-get update -qq
  run apt-get install -y -qq curl git openssl ca-certificates postgresql redis-server
  ok "curl git openssl postgresql redis-server"

  # Node is installed from NodeSource rather than the distribution, which ships
  # a version older than the engines field allows (>=20).
  NEED_NODE=1
  if command -v node >/dev/null 2>&1; then
    CURRENT_MAJOR="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
    if [ "$CURRENT_MAJOR" -ge 20 ] 2>/dev/null; then
      ok "node $(node --version) already satisfies >=20"
      NEED_NODE=0
    else
      info "node $(node --version) is older than the required >=20"
    fi
  fi

  if [ "$NEED_NODE" = "1" ]; then
    info "installing Node.js ${NODE_MAJOR}.x from NodeSource"
    if [ "$DRY_RUN" = "1" ]; then
      printf '    \033[2mwould run:\033[0m curl -fsSL https://deb.nodesource.com/setup_%s.x | bash -\n' "$NODE_MAJOR"
    else
      curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
      apt-get install -y -qq nodejs
      ok "node $(node --version)"
    fi
  fi
fi

# Postgres and Redis must be running before the migration step.
for svc in postgresql redis-server; do
  if systemctl list-unit-files "$svc.service" >/dev/null 2>&1; then
    run systemctl enable --now "$svc"
  fi
done

# ── 2. service account ────────────────────────────────────────────────────────

step "2. Service account and directories"

if id -u "$SERVICE_USER" >/dev/null 2>&1; then
  skip "user $SERVICE_USER already exists"
else
  run useradd --system --create-home --home-dir "$INSTALL_ROOT" --shell /bin/bash "$SERVICE_USER"
  ok "created $SERVICE_USER"
fi

run mkdir -p "$LOG_DIR" "$INSTALL_ROOT"
run chown "$SERVICE_USER:$SERVICE_USER" "$LOG_DIR"
ok "$LOG_DIR"

# ── 3. application code ───────────────────────────────────────────────────────

step "3. Application code"

if [ -f "$INSTALL_ROOT/package.json" ]; then
  skip "already deployed at $INSTALL_ROOT"
elif [ "$SOURCE_ROOT" = "$INSTALL_ROOT" ]; then
  skip "running from $INSTALL_ROOT"
elif [ -n "$REPO_URL" ]; then
  info "cloning $REPO_URL"
  run sudo -u "$SERVICE_USER" git clone "$REPO_URL" "$INSTALL_ROOT"
  ok "cloned"
else
  info "copying $SOURCE_ROOT -> $INSTALL_ROOT"
  # node_modules and build output are rebuilt below; .git and .env are not
  # copied, so a checkout used for staging cannot leak its secrets here.
  run rsync -a \
    --exclude node_modules --exclude .git --exclude .env \
    --exclude 'backend/dist' --exclude 'frontend/.next' --exclude '.runtime' \
    "$SOURCE_ROOT/" "$INSTALL_ROOT/"
  ok "copied"
fi

run chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_ROOT"

# ── 4. configuration ──────────────────────────────────────────────────────────

step "4. Configuration"

if [ -f "$INSTALL_ROOT/.env" ]; then
  skip ".env exists — not overwritten (SECRETS_ROOT_KEY must survive)"
  GENERATED_DB_PASSWORD=""
else
  run sudo -u "$SERVICE_USER" bash "$INSTALL_ROOT/infrastructure/scripts/bootstrap-env.sh"

  if [ -z "$DB_PASSWORD" ]; then
    DB_PASSWORD="$(openssl rand -hex 24)"
    GENERATED_DB_PASSWORD="$DB_PASSWORD"
  else
    GENERATED_DB_PASSWORD=""
  fi

  if [ "$DRY_RUN" != "1" ]; then
    # Production settings the bootstrap template does not know about. Written
    # with sed on the generated file rather than appended, so the file keeps one
    # entry per variable.
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

# ── 5. database ───────────────────────────────────────────────────────────────

step "5. Database"

if [ "$SKIP_DATABASE" = "1" ]; then
  skip "SKIP_DATABASE=1"
elif [ "$DRY_RUN" = "1" ]; then
  printf '    \033[2mwould run:\033[0m CREATE ROLE %s / CREATE DATABASE %s\n' "$DB_USER" "$DB_NAME"
else
  # Read the password back from .env rather than trusting the variable: on a
  # re-run the file is the authority, and the role may already exist with it.
  ENV_DB_URL="$(grep -E '^DATABASE_URL=' "$INSTALL_ROOT/.env" | cut -d= -f2- || true)"
  ENV_DB_PASSWORD="$(printf '%s' "$ENV_DB_URL" | sed -E 's#.*://[^:]+:([^@]+)@.*#\1#')"

  # A non-matching sed returns its input unchanged, so an empty check is not
  # enough: a URL carrying no password would otherwise be used *as* the
  # password, and the role would be created with a credential nobody knows.
  if [ -z "$ENV_DB_PASSWORD" ] || [ "$ENV_DB_PASSWORD" = "$ENV_DB_URL" ]; then
    fail "DATABASE_URL in $INSTALL_ROOT/.env has no password in the form postgresql://user:password@host:port/db"
  fi

  if su postgres -s /bin/sh -c "psql -tAc \"select 1 from pg_roles where rolname='${DB_USER}'\"" | grep -q 1; then
    skip "role $DB_USER exists"
  else
    su postgres -s /bin/sh -c "psql -q" <<SQL
CREATE ROLE ${DB_USER} WITH LOGIN PASSWORD '${ENV_DB_PASSWORD}';
SQL
    ok "created role $DB_USER"
  fi

  if su postgres -s /bin/sh -c "psql -tAc \"select 1 from pg_database where datname='${DB_NAME}'\"" | grep -q 1; then
    skip "database $DB_NAME exists"
  else
    su postgres -s /bin/sh -c "psql -q" <<SQL
CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};
SQL
    ok "created database $DB_NAME"
  fi
fi

# ── 6. build and migrate ──────────────────────────────────────────────────────

step "6. Build and migrate"

run sudo -u "$SERVICE_USER" bash -c "cd '$INSTALL_ROOT' && npm ci --silent"
ok "dependencies installed"

run sudo -u "$SERVICE_USER" bash -c "cd '$INSTALL_ROOT' && npm run build"
ok "backend and portal built"

run sudo -u "$SERVICE_USER" bash -c "cd '$INSTALL_ROOT' && npm run db:migrate"
ok "migrations applied"

# ── 7. model gateway ──────────────────────────────────────────────────────────

step "7. Model gateway (9router)"

if [ -e "$GATEWAY_LINK" ]; then
  skip "$GATEWAY_LINK exists"
else
  if command -v npm >/dev/null 2>&1 && [ "$DRY_RUN" != "1" ]; then
    npm install -g 9router --silent >/dev/null 2>&1 || warn "9router install failed; install it manually"
    GLOBAL_ROOT="$(npm root -g)"
    if [ -d "$GLOBAL_ROOT/9router" ]; then
      ln -sfn "$GLOBAL_ROOT/9router" "$GATEWAY_LINK"
      ok "linked $GATEWAY_LINK"
    else
      warn "9router not found under $GLOBAL_ROOT — §5 of the install guide"
    fi
  else
    run npm install -g 9router
  fi
fi

# ── 8. services ───────────────────────────────────────────────────────────────

step "8. Services"

for unit in "$UNIT_SOURCE"/*.service; do
  name="$(basename "$unit")"
  run install -m 0644 "$unit" "/etc/systemd/system/$name"
  info "$name"
done

run systemctl daemon-reload

UNITS="cartenz-api cartenz-worker cartenz-portal"
if [ -e "$GATEWAY_LINK" ] || [ "$DRY_RUN" = "1" ]; then
  UNITS="9router $UNITS"
else
  # Enabling a unit whose ExecStart does not exist would leave a service in a
  # restart loop. Say so instead: Cartenz still starts, and the chain can point
  # at any OpenAI-compatible endpoint.
  warn "9router not installed — its unit is left disabled (§5 of the install guide)"
fi

# shellcheck disable=SC2086
run systemctl enable $UNITS
# shellcheck disable=SC2086
run systemctl restart $UNITS
ok "enabled and started: $UNITS"

# ── 9. log rotation ───────────────────────────────────────────────────────────

step "9. Log rotation"

if [ -f /etc/logrotate.d/cartenz ]; then
  skip "/etc/logrotate.d/cartenz exists"
elif [ "$DRY_RUN" = "1" ]; then
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

# ── 10. verify ────────────────────────────────────────────────────────────────

step "10. Verify"

if [ "$DRY_RUN" = "1" ]; then
  skip "dry run"
else
  # `|| true` matters: under `set -e` a grep that finds nothing would abort the
  # script here, after a successful install, which reads as a failed deployment.
  API_PORT="$(grep -E '^API_PORT=' "$INSTALL_ROOT/.env" 2>/dev/null | cut -d= -f2- || true)"
  API_PORT="${API_PORT:-4000}"

  # The API opens its database pool at boot; give it a moment before asking.
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

# ── summary ───────────────────────────────────────────────────────────────────

cat <<EOF

────────────────────────────────────────────────────────────────
Installed at $INSTALL_ROOT, running as $SERVICE_USER.

Next, in this order:

  1. Back up the secret. Losing it loses every stored credential:
       $INSTALL_ROOT/.env  (SECRETS_ROOT_KEY)

  2. Point Cartenz at a model gateway. Edit AI_BASE_URL and
     AI_API_KEY in .env, then: systemctl restart cartenz-api cartenz-worker

  3. Put a reverse proxy with TLS in front. The services listen on
     loopback and are not reachable until you do.
     See docs/INSTALL-SERVER.md §7.

  4. Open the portal, register the first account, and add the model
     provider chain under Settings. Use the Test button on each row:
     a model that refuses a strict json_schema must have structured
     outputs switched off, or planning calls against it hang.

Logs:   $LOG_DIR/
Health: curl -s localhost:${API_PORT:-4000}/api/v1/health/ready
Guide:  $INSTALL_ROOT/docs/INSTALL-SERVER.md
────────────────────────────────────────────────────────────────
EOF

if [ -n "${GENERATED_DB_PASSWORD:-}" ]; then
  echo
  warn "A database password was generated and written to .env."
  info "It is not printed here. Read it with: sudo grep DATABASE_URL $INSTALL_ROOT/.env"
fi
