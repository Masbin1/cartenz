#!/usr/bin/env bash
# shellcheck shell=bash
#
# Stage: base — system packages, Node.js, PostgreSQL, Redis, service account.

step "base: system packages"

if [ "${SKIP_PACKAGES:-0}" = "1" ]; then
  skip "SKIP_PACKAGES=1"
else
  run apt-get update -qq
  run apt-get install -y -qq curl git openssl ca-certificates postgresql redis-server rsync
  ok "curl git openssl postgresql redis-server rsync"

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
    if [ "${DRY_RUN:-0}" = "1" ]; then
      printf '    \033[2mwould run:\033[0m curl -fsSL https://deb.nodesource.com/setup_%s.x | bash -\n' "$NODE_MAJOR"
    else
      curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
      run apt-get install -y -qq nodejs
      ok "node $(node --version)"
    fi
  fi
fi

# Postgres and Redis must be running before anything touches the database.
for svc in postgresql redis-server; do
  if unit_exists "$svc"; then
    run systemctl enable --now "$svc"
  fi
done

step "base: service account and directories"

if id -u "$SERVICE_USER" >/dev/null 2>&1; then
  skip "user $SERVICE_USER already exists"
else
  run useradd --system --create-home --home-dir "$INSTALL_ROOT" --shell /bin/bash "$SERVICE_USER"
  ok "created $SERVICE_USER"
fi

run mkdir -p "$LOG_DIR" "$INSTALL_ROOT"
run chown "$SERVICE_USER:$SERVICE_USER" "$LOG_DIR"
ok "$LOG_DIR"

summary "base: packages, service account $SERVICE_USER at $INSTALL_ROOT"
