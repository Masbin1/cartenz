#!/usr/bin/env bash
# shellcheck shell=bash
#
# Stage: hermes — the Hermes agent (OPT-IN).
#
# Clones Hermes, builds its venv through its own setup script, generates the
# loopback API key, and installs the API unit. Then wires Cartenz's default
# engine at the local Hermes API.
#
# Heavy on purpose: a Hermes chat call runs ~12 minutes, and change-task
# planning fails its schema and fails over. Keep a 9router/Claude row in the
# portal below Hermes for change work. This is why the stage is opt-in.

step "hermes: prerequisites (python3.11, uv)"

if ! command -v python3.11 >/dev/null 2>&1; then
  run apt-get install -y -qq python3.11 python3.11-venv || \
    warn "python3.11 not available from apt on this release — install it, then re-run"
fi
command -v python3.11 >/dev/null 2>&1 && ok "python3.11 present" || warn "python3.11 missing"

UV_BIN="$INSTALL_ROOT/.local/bin/uv"
if [ -x "$UV_BIN" ]; then
  ok "uv present for $SERVICE_USER"
elif [ "${DRY_RUN:-0}" = "1" ]; then
  info "would install uv for $SERVICE_USER via astral.sh installer"
else
  info "installing uv for $SERVICE_USER"
  as_user_sh 'curl -LsSf https://astral.sh/uv/install.sh | sh' \
    || warn "uv install failed — install uv for $SERVICE_USER, then re-run"
fi

step "hermes: clone and build"

run mkdir -p "$HERMES_HOME_DIR"
run chown "$SERVICE_USER:$SERVICE_USER" "$HERMES_HOME_DIR"

if [ -d "$HERMES_SRC/.git" ]; then
  skip "Hermes already cloned at $HERMES_SRC"
elif [ "${DRY_RUN:-0}" = "1" ]; then
  info "would clone $HERMES_REPO ($HERMES_REF) -> $HERMES_SRC"
else
  info "cloning $HERMES_REPO ($HERMES_REF)"
  as_user git clone --branch "$HERMES_REF" --depth 1 "$HERMES_REPO" "$HERMES_SRC" \
    || fail "git clone of Hermes failed. If it is a private repo, give $SERVICE_USER access (deploy key/token) or set HERMES_REPO."
  ok "cloned"
fi

if [ -x "$HERMES_SRC/venv/bin/python" ]; then
  skip "Hermes venv already built"
elif [ "${DRY_RUN:-0}" = "1" ]; then
  info "would run setup-hermes.sh (non-interactive) as $SERVICE_USER"
else
  info "running setup-hermes.sh (answers piped, wizard skipped)"
  as_user_sh "cd '$HERMES_SRC' && printf 'n\nn\n' | ./setup-hermes.sh" \
    || fail "setup-hermes.sh failed — check output above"
  ok "venv built, deps installed"
fi

step "hermes: .env and API key"

if [ "${DRY_RUN:-0}" = "1" ]; then
  info "would ensure $HERMES_ENV exists, upsert API_SERVER_KEY (generated), append model keys if given"
else
  [ -f "$HERMES_ENV" ] || as_user cp "$HERMES_SRC/.env.example" "$HERMES_ENV" 2>/dev/null || as_user touch "$HERMES_ENV"

  if env_key_set API_SERVER_KEY "$HERMES_ENV"; then
    skip "API_SERVER_KEY already set — kept"
  else
    GEN_KEY="$(openssl rand -hex 32)"
    upsert_env "$HERMES_ENV" "$SERVICE_USER" 600 API_SERVER_KEY "$GEN_KEY"
    ok "generated API_SERVER_KEY"
  fi

  if [ -n "$HERMES_MODEL_KEYS_FILE" ]; then
    while IFS= read -r line; do
      case "$line" in ''|\#*) continue ;; esac
      k="${line%%=*}"; v="${line#*=}"
      upsert_env "$HERMES_ENV" "$SERVICE_USER" 600 "$k" "$v"
    done < "$HERMES_MODEL_KEYS_FILE"
    ok "merged model keys from $HERMES_MODEL_KEYS_FILE"
  else
    warn "no HERMES_MODEL_KEYS_FILE given — Hermes' own model provider is not keyed."
    info "Add its key later to $HERMES_ENV, then: systemctl restart hermes-api"
  fi

  chmod 600 "$HERMES_ENV"; chown "$SERVICE_USER:$SERVICE_USER" "$HERMES_ENV"
  ok "$HERMES_ENV (mode 600)"
fi

step "hermes: API service (127.0.0.1:$HERMES_PORT)"

HERMES_UNIT=/etc/systemd/system/hermes-api.service
HERMES_LAUNCH="$HERMES_SRC/venv/bin/python -m hermes_cli.main gateway run"

if [ "${DRY_RUN:-0}" = "1" ]; then
  info "would write $HERMES_UNIT (ExecStart: $HERMES_LAUNCH) and enable it"
else
  cat > "$HERMES_UNIT" <<EOF
[Unit]
Description=Hermes Agent API (OpenAI-compatible, loopback)
After=network.target
Documentation=https://claude-code.nousresearch.com/docs

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
Environment=HOME=$INSTALL_ROOT
Environment=HERMES_HOME=$HERMES_HOME_DIR
WorkingDirectory=$HERMES_SRC
ExecStart=$HERMES_LAUNCH
Restart=on-failure
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
  chmod 644 "$HERMES_UNIT"
  run systemctl daemon-reload
  run systemctl enable hermes-api
  run systemctl restart hermes-api || warn "hermes-api failed to start — journalctl -u hermes-api"
  ok "hermes-api enabled and started"
fi

step "hermes: point Cartenz's default engine at Hermes"

CARTENZ_ENV="$INSTALL_ROOT/.env"

if [ "${WIRE_CARTENZ_TO_HERMES:-1}" != "1" ]; then
  skip "WIRE_CARTENZ_TO_HERMES=0 — leaving Cartenz's engine to the portal"
elif [ "${DRY_RUN:-0}" = "1" ]; then
  info "would set AI_BASE_URL=http://127.0.0.1:$HERMES_PORT/v1, AI_API_KEY=<hermes key>, AI_MODEL=hermes-agent in $CARTENZ_ENV"
else
  [ -f "$CARTENZ_ENV" ] || fail "$CARTENZ_ENV not found — did the cartenz stage run before this one?"
  HKEY="$(env_get API_SERVER_KEY "$HERMES_ENV")"

  upsert_env "$CARTENZ_ENV" "$SERVICE_USER" 600 AI_BASE_URL "http://127.0.0.1:$HERMES_PORT/v1"
  upsert_env "$CARTENZ_ENV" "$SERVICE_USER" 600 AI_MODEL "hermes-agent"
  [ -n "$HKEY" ] && upsert_env "$CARTENZ_ENV" "$SERVICE_USER" 600 AI_API_KEY "$HKEY"

  run systemctl restart cartenz-api cartenz-worker || \
    warn "restart cartenz-api/worker manually to apply the engine change"
  ok "Cartenz default engine -> Hermes (add a 9router/Claude row in the portal for change tasks)"
fi

HH=""
if [ "${DRY_RUN:-0}" != "1" ]; then
  for _ in $(seq 1 10); do
    HH="$(curl -fsS -m 3 "http://127.0.0.1:$HERMES_PORT/health" 2>/dev/null || true)"
    case "$HH" in *'"status"'*) break ;; esac
    sleep 2
  done
  case "$HH" in
    *'"status"'*) ok "hermes /health: $HH" ;;
    *) warn "Hermes /health not answering yet — journalctl -u hermes-api" ;;
  esac
fi

summary "hermes: API on 127.0.0.1:$HERMES_PORT, wired to Cartenz $([ "${WIRE_CARTENZ_TO_HERMES:-1}" = "1" ] && echo yes || echo no)"
