#!/usr/bin/env bash
#
# Full VPS installer: Cartenz platform + 9router + Hermes, all under one service
# account, all as systemd units. Run once on a fresh Ubuntu server.
#
#   sudo ./infrastructure/scripts/install-vps-full.sh
#
# What it installs, in order:
#
#   1. install-server.sh       -> Cartenz platform (packages, DB, build, 9router,
#                                 cartenz-api/worker/portal units)
#   2. Hermes agent            -> cloned + built under the service user's home,
#                                 API server exposed on 127.0.0.1:8642 as a
#                                 systemd unit (hermes-api.service)
#   3. wiring                  -> Cartenz's default engine (.env AI_BASE_URL /
#                                 AI_API_KEY) pointed at the local Hermes API
#
# Secrets are handled by REFERENCE, never baked in:
#   - API_SERVER_KEY (the key Cartenz uses to call Hermes) is generated here and
#     written to Hermes' own .env, mode 600.
#   - Hermes' OWN model key (what Hermes uses to reach a model — Anthropic, etc.)
#     is NOT invented. Supply it via HERMES_MODEL_KEYS_FILE (a file of KEY=VALUE
#     lines appended to Hermes' .env) or add it after install. Without it Hermes
#     installs and its API answers /health, but model calls fail until keyed.
#
# This installs Hermes because you asked for it. Reminder of the verified
# trade-off (docs/guides/server-setup-from-scratch.md §6): a Hermes chat call
# runs ~12 min, and change-task planning fails its schema and fails over to the
# next provider. Keep a 9router/Claude row in the portal below Hermes for change.
#
# Idempotent: install-server.sh skips what exists; the Hermes clone/venv/unit are
# each guarded; .env keys are upserted in place, never duplicated.
#
# Environment overrides:
#   INSTALL_ROOT           Cartenz + service-user home     (default /opt/cartenz)
#   SERVICE_USER           account everything runs as        (default cartenz)
#   HERMES_REPO            Hermes git source (needs access)
#                          (default https://github.com/NousResearch/hermes-agent.git)
#   HERMES_REF             branch/tag to check out           (default main)
#   HERMES_PORT            Hermes API loopback port          (default 8642)
#   HERMES_MODEL_KEYS_FILE optional file of KEY=VALUE lines appended to Hermes .env
#   WIRE_CARTENZ_TO_HERMES =0 to skip pointing Cartenz's default engine at Hermes
#   DRY_RUN                =1 to print the plan and change nothing
#
# install-server.sh overrides (DB_NAME, DB_USER, REPO_URL, SKIP_PACKAGES, ...)
# pass straight through.
set -euo pipefail

INSTALL_ROOT="${INSTALL_ROOT:-/opt/cartenz}"
SERVICE_USER="${SERVICE_USER:-cartenz}"
HERMES_REPO="${HERMES_REPO:-https://github.com/NousResearch/hermes-agent.git}"
HERMES_REF="${HERMES_REF:-main}"
HERMES_PORT="${HERMES_PORT:-8642}"
HERMES_MODEL_KEYS_FILE="${HERMES_MODEL_KEYS_FILE:-}"
WIRE_CARTENZ_TO_HERMES="${WIRE_CARTENZ_TO_HERMES:-1}"
DRY_RUN="${DRY_RUN:-0}"

HERMES_HOME_DIR="$INSTALL_ROOT/.hermes"              # ~/.hermes for the service user
HERMES_SRC="$HERMES_HOME_DIR/hermes-agent"
HERMES_ENV="$HERMES_HOME_DIR/.env"
HERMES_UNIT=/etc/systemd/system/hermes-api.service

# ── output (matches install-server.sh) ─────────────────────────────────────────

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

# Run a command as the service user with a clean environment. sudo -H sets HOME so
# uv/venv and Hermes resolve config under the service user's home, not root's.
as_user() {
  if [ "$DRY_RUN" = "1" ]; then
    printf '    \033[2mwould run (as %s):\033[0m %s\n' "$SERVICE_USER" "$*"
  else
    sudo -H -u "$SERVICE_USER" "$@"
  fi
}

# ── preflight ──────────────────────────────────────────────────────────────────

step "Preflight"

[ "$(id -u)" = "0" ] || fail "Run as root: sudo $0"
command -v systemctl >/dev/null 2>&1 || fail "systemd is required (services are systemd units)."

SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
SCRIPTS_DIR="$(dirname "$SCRIPT_PATH")"
INSTALLER="$SCRIPTS_DIR/install-server.sh"
[ -x "$INSTALLER" ] || fail "install-server.sh not found next to this script ($INSTALLER)"
ok "platform installer $INSTALLER"

if [ -n "$HERMES_MODEL_KEYS_FILE" ] && [ ! -f "$HERMES_MODEL_KEYS_FILE" ]; then
  fail "HERMES_MODEL_KEYS_FILE=$HERMES_MODEL_KEYS_FILE does not exist"
fi

if [ "$DRY_RUN" = "1" ]; then warn "DRY_RUN=1 — nothing will be changed."; fi

# ── 1. platform ────────────────────────────────────────────────────────────────

step "1. Install the Cartenz platform (+ 9router)"
info "delegating to install-server.sh"
run env INSTALL_ROOT="$INSTALL_ROOT" SERVICE_USER="$SERVICE_USER" DRY_RUN="$DRY_RUN" \
  bash "$INSTALLER"

CARTENZ_ENV="$INSTALL_ROOT/.env"

# ── 2. Hermes prerequisites ────────────────────────────────────────────────────

step "2. Hermes prerequisites (python3.11, uv)"

# Hermes targets Python 3.11 and uses uv for its venv (setup-hermes.sh).
if ! command -v python3.11 >/dev/null 2>&1; then
  run apt-get install -y -qq python3.11 python3.11-venv || \
    warn "python3.11 not available from apt on this release — install it, then re-run"
fi
command -v python3.11 >/dev/null 2>&1 && ok "python3.11 present" || warn "python3.11 missing"

# uv installed into the service user's home so the venv build runs as that user.
UV_BIN="$INSTALL_ROOT/.local/bin/uv"
if [ -x "$UV_BIN" ] || as_user bash -lc 'command -v uv >/dev/null 2>&1'; then
  ok "uv present for $SERVICE_USER"
elif [ "$DRY_RUN" = "1" ]; then
  info "would install uv for $SERVICE_USER via astral.sh installer"
else
  info "installing uv for $SERVICE_USER"
  as_user bash -lc 'curl -LsSf https://astral.sh/uv/install.sh | sh' \
    || warn "uv install failed — install uv for $SERVICE_USER, then re-run"
fi

# ── 3. clone + build Hermes ────────────────────────────────────────────────────

step "3. Install Hermes under $HERMES_HOME_DIR"

run mkdir -p "$HERMES_HOME_DIR"
run chown "$SERVICE_USER:$SERVICE_USER" "$HERMES_HOME_DIR"

if [ -d "$HERMES_SRC/.git" ]; then
  skip "Hermes already cloned at $HERMES_SRC"
elif [ "$DRY_RUN" = "1" ]; then
  info "would clone $HERMES_REPO ($HERMES_REF) -> $HERMES_SRC"
else
  info "cloning $HERMES_REPO ($HERMES_REF)"
  as_user git clone --branch "$HERMES_REF" --depth 1 "$HERMES_REPO" "$HERMES_SRC" \
    || fail "git clone of Hermes failed. If it is a private repo, give $SERVICE_USER access (deploy key/token) or set HERMES_REPO."
  ok "cloned"
fi

# Build the venv + install deps by running Hermes' own setup, non-interactively.
# setup-hermes.sh prompts (ripgrep, setup wizard); pipe 'n' so it never blocks.
# It creates the venv, installs deps, writes .env from template, symlinks hermes.
step "4. Build Hermes venv and dependencies"
if [ -x "$HERMES_SRC/venv/bin/python" ]; then
  skip "Hermes venv already built"
elif [ "$DRY_RUN" = "1" ]; then
  info "would run setup-hermes.sh (non-interactive) as $SERVICE_USER"
else
  info "running setup-hermes.sh (answers piped, wizard skipped)"
  # printf feeds: ripgrep prompt = n, setup-wizard prompt = n.
  as_user bash -lc "cd '$HERMES_SRC' && printf 'n\nn\n' | ./setup-hermes.sh" \
    || fail "setup-hermes.sh failed — check output above"
  ok "venv built, deps installed"
fi

# ── 5. Hermes .env + API key ───────────────────────────────────────────────────

step "5. Configure Hermes .env and API key"

if [ "$DRY_RUN" = "1" ]; then
  info "would ensure $HERMES_ENV exists, upsert API_SERVER_KEY (generated), append model keys if given"
else
  # setup-hermes.sh already copies .env.example -> .env; ensure it exists.
  [ -f "$HERMES_ENV" ] || as_user cp "$HERMES_SRC/.env.example" "$HERMES_ENV" 2>/dev/null || as_user touch "$HERMES_ENV"

  upsert_hermes_env() {
    local key="$1" val="$2" tmp
    tmp="$(mktemp)"
    grep -vE "^${key}=" "$HERMES_ENV" > "$tmp" 2>/dev/null || true
    printf '%s=%s\n' "$key" "$val" >> "$tmp"
    install -m 600 -o "$SERVICE_USER" -g "$SERVICE_USER" "$tmp" "$HERMES_ENV"
    rm -f "$tmp"
  }

  # Generate API_SERVER_KEY once. Hermes refuses to start without it, even on
  # loopback. If one already exists, keep it (it may already be wired elsewhere).
  if grep -qE '^API_SERVER_KEY=.+' "$HERMES_ENV" 2>/dev/null; then
    skip "API_SERVER_KEY already set — kept"
  else
    GEN_KEY="$(openssl rand -hex 32)"
    upsert_hermes_env API_SERVER_KEY "$GEN_KEY"
    ok "generated API_SERVER_KEY"
  fi

  # Append the operator-supplied model keys (Hermes' own provider auth).
  if [ -n "$HERMES_MODEL_KEYS_FILE" ]; then
    while IFS= read -r line; do
      case "$line" in ''|\#*) continue ;; esac
      k="${line%%=*}"; v="${line#*=}"
      upsert_hermes_env "$k" "$v"
    done < "$HERMES_MODEL_KEYS_FILE"
    ok "merged model keys from $HERMES_MODEL_KEYS_FILE"
  else
    warn "no HERMES_MODEL_KEYS_FILE given — Hermes' own model provider is not keyed."
    info "Add its key later (e.g. ANTHROPIC_API_KEY / AI_BASE_URL) to $HERMES_ENV, then: systemctl restart hermes-api"
  fi

  chmod 600 "$HERMES_ENV"; chown "$SERVICE_USER:$SERVICE_USER" "$HERMES_ENV"
  ok "$HERMES_ENV (mode 600)"
fi

# ── 6. Hermes API systemd unit ─────────────────────────────────────────────────

step "6. Hermes API service (127.0.0.1:$HERMES_PORT)"

HERMES_LAUNCH="$HERMES_SRC/venv/bin/python -m hermes_cli.main gateway run"

if [ "$DRY_RUN" = "1" ]; then
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
  systemctl daemon-reload
  systemctl enable hermes-api >/dev/null 2>&1 || true
  systemctl restart hermes-api || warn "hermes-api failed to start — journalctl -u hermes-api"
  ok "hermes-api enabled and started"
fi

# ── 7. wire Cartenz -> Hermes ──────────────────────────────────────────────────

step "7. Point Cartenz's default engine at Hermes"

if [ "$WIRE_CARTENZ_TO_HERMES" != "1" ]; then
  skip "WIRE_CARTENZ_TO_HERMES=0 — leaving Cartenz's engine to the portal"
elif [ "$DRY_RUN" = "1" ]; then
  info "would set AI_BASE_URL=http://127.0.0.1:$HERMES_PORT/v1, AI_API_KEY=<hermes key>, AI_MODEL=hermes-agent in $CARTENZ_ENV"
else
  [ -f "$CARTENZ_ENV" ] || fail "$CARTENZ_ENV not found — did the platform step run?"
  HKEY="$(grep -E '^API_SERVER_KEY=' "$HERMES_ENV" | cut -d= -f2- || true)"

  upsert_cartenz_env() {
    local key="$1" val="$2" tmp
    tmp="$(mktemp)"
    grep -vE "^${key}=" "$CARTENZ_ENV" > "$tmp" 2>/dev/null || true
    printf '%s=%s\n' "$key" "$val" >> "$tmp"
    install -m 600 -o "$SERVICE_USER" -g "$SERVICE_USER" "$tmp" "$CARTENZ_ENV"
    rm -f "$tmp"
  }

  upsert_cartenz_env AI_BASE_URL "http://127.0.0.1:$HERMES_PORT/v1"
  upsert_cartenz_env AI_MODEL    "hermes-agent"
  [ -n "$HKEY" ] && upsert_cartenz_env AI_API_KEY "$HKEY"

  systemctl restart cartenz-api cartenz-worker 2>/dev/null || \
    warn "restart cartenz-api/worker manually to apply the engine change"
  ok "Cartenz default engine -> Hermes (add a 9router/Claude row in the portal for change tasks)"
fi

# ── 8. verify ──────────────────────────────────────────────────────────────────

step "8. Verify"

if [ "$DRY_RUN" = "1" ]; then
  skip "dry run"
else
  for unit in cartenz-api cartenz-worker cartenz-portal 9router hermes-api; do
    state="$(systemctl is-active "$unit" 2>/dev/null || true)"
    if [ "$state" = "active" ]; then ok "$unit active"; else warn "$unit is $state"; fi
  done

  HH=""
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

# ── summary ────────────────────────────────────────────────────────────────────

cat <<EOF

────────────────────────────────────────────────────────────────
Installed under $INSTALL_ROOT, running as $SERVICE_USER:

  cartenz-api / cartenz-worker / cartenz-portal   (platform)
  9router                                         (model gateway)
  hermes-api                                      (127.0.0.1:$HERMES_PORT)

Cartenz default engine -> Hermes ($([ "$WIRE_CARTENZ_TO_HERMES" = "1" ] && echo wired || echo skipped)).

Do this next, in order:

  1. Give Hermes its own model key if you have not:
       edit $HERMES_ENV  (e.g. ANTHROPIC_API_KEY=..., or AI_BASE_URL/AI_MODEL)
       systemctl restart hermes-api

  2. Reverse proxy + TLS for the portal (:3000) and API (:4000) only.
     9router, Hermes ($HERMES_PORT), Postgres, Redis stay on loopback —
     never expose Hermes to the network. docs/INSTALL-SERVER.md §7.

  3. Portal -> Settings -> Model providers: keep Hermes for chat, and add a
     9router/Claude row BELOW it for change tasks (Hermes change planning
     fails its schema and fails over). Test each row.

  4. Verify:
       curl -s http://127.0.0.1:$HERMES_PORT/health
       curl -s http://127.0.0.1:4000/api/v1/health/ready

To replicate THIS laptop's Hermes config (providers, memories) instead of
keying fresh, copy it over once (secrets included — do it over SSH, not git):
  rsync -a --exclude cache --exclude logs ~/.hermes/  <vps>:$HERMES_HOME_DIR/
then: chown -R $SERVICE_USER:$SERVICE_USER $HERMES_HOME_DIR && systemctl restart hermes-api
────────────────────────────────────────────────────────────────
EOF
