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
#   HERMES_MODEL_NAME      model id Hermes itself should use (e.g. cc/claude-sonnet-5).
#                          Without it, step 8 prints the manual wiring instead.
#   HERMES_MODEL_BASE_URL  endpoint for Hermes' own brain (default the 9router URL)
#   HERMES_MODEL_KEY_ENV   env var in Hermes' .env holding that endpoint's key
#                          (default AI_API_KEY)
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
ROUTER_PORT="${ROUTER_PORT:-20128}"                 # 9router loopback port (see 9router.service)
HERMES_MODEL_KEYS_FILE="${HERMES_MODEL_KEYS_FILE:-}"
HERMES_MODEL_NAME="${HERMES_MODEL_NAME:-}"
HERMES_MODEL_BASE_URL="${HERMES_MODEL_BASE_URL:-}"
HERMES_MODEL_KEY_ENV="${HERMES_MODEL_KEY_ENV:-AI_API_KEY}"
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

# The full stack (Postgres, Redis, API, worker, portal, 9router, Hermes) does not
# fit a small VPS without swap. With none, the kernel kills processes mid-request
# and leaves NO OOM line in dmesg — a genuinely hard bug to chase. Warn, never fail.
if [ "$(awk '/^SwapTotal:/{print $2}' /proc/meminfo)" = "0" ]; then
  warn "no swap configured — add a swapfile (docs/INSTALL-SERVER.md §1.1)"
fi

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

# ── 7. global `hermes` command ─────────────────────────────────────────────────
# Hermes installs into the service user's venv; there is no global entrypoint, so
# `hermes` typed by root (or any other user) returns "command not found" and — worse
# — running the venv binary as root without HERMES_HOME spawns a fresh, empty config
# under /root/.hermes that is NOT the running service. This wrapper makes `hermes`
# work from any shell, always as $SERVICE_USER with the correct HOME/HERMES_HOME.

step "7. Global hermes command (/usr/local/bin/hermes)"

HERMES_WRAPPER=/usr/local/bin/hermes

if [ "$DRY_RUN" = "1" ]; then
  info "would write $HERMES_WRAPPER (runs the venv hermes as $SERVICE_USER with HERMES_HOME=$HERMES_HOME_DIR)"
else
  cat > "$HERMES_WRAPPER" <<EOF
#!/usr/bin/env bash
# Global entrypoint for Hermes. The install lives in $SERVICE_USER's venv, not on
# the system PATH; this always runs it as $SERVICE_USER with the correct HOME and
# HERMES_HOME so every invocation hits the SAME config the hermes-api service uses.
#
# It also cd's to $INSTALL_ROOT first, for two reasons:
#   1. Hermes walks UP from the current directory looking for a project context
#      file (.hermes.md / HERMES.md). Started from /root by a non-root user, that
#      walk reaches /root (mode 0700) and dies with "Permission denied:
#      '/root/.hermes.md'".
#   2. sudo keeps the caller's working directory, so a plain cd here also fixes
#      where the re-exec lands — no nested quoting needed.
HERMES_BIN="$HERMES_SRC/venv/bin/hermes"
SAFE_CWD="$INSTALL_ROOT"
cd "\$SAFE_CWD" 2>/dev/null || true
if [ "\$(id -un)" = "$SERVICE_USER" ]; then
  exec env HOME="$INSTALL_ROOT" HERMES_HOME="$HERMES_HOME_DIR" "\$HERMES_BIN" "\$@"
else
  exec sudo -u "$SERVICE_USER" env HOME="$INSTALL_ROOT" HERMES_HOME="$HERMES_HOME_DIR" "\$HERMES_BIN" "\$@"
fi
EOF
  chmod 755 "$HERMES_WRAPPER"
  if [ -x "$HERMES_SRC/venv/bin/hermes" ] && "$HERMES_WRAPPER" --version >/dev/null 2>&1; then
    ok "hermes command available (try: hermes doctor)"
  else
    warn "$HERMES_WRAPPER written, but 'hermes --version' did not answer yet — check after the venv build completes"
  fi
fi

# ── 8. point Hermes' own brain at a model ──────────────────────────────────────
# Hermes does NOT read AI_PROVIDER / AI_MODEL / AI_BASE_URL from .env for its own
# inference — those are Cartenz's keys. Its model lives in ~/.hermes/config.yaml
# and is set through `hermes config set`, never by hand (a stray indent breaks
# the live service).
#
# Give HERMES_MODEL_NAME (plus optionally HERMES_MODEL_BASE_URL) and this step
# wires it non-interactively. Without it the step prints the manual commands — an
# unkeyed Hermes still answers /health, it just cannot complete a model call.

step "8. Point Hermes' own brain at a model"

HERMES_MODEL_BASE_URL="${HERMES_MODEL_BASE_URL:-http://127.0.0.1:$ROUTER_PORT/v1}"

if [ -z "$HERMES_MODEL_NAME" ]; then
  skip "HERMES_MODEL_NAME not set — Hermes is installed but has no model yet"
  info "Pick an id the gateway serves, then wire it yourself:"
  info "  curl -s $HERMES_MODEL_BASE_URL/models"
  info "  hermes config set model.provider custom"
  info "  hermes config set model.base_url $HERMES_MODEL_BASE_URL"
  info "  hermes config set model.default  <served-model-id>"
  info "  hermes config set model.api_key  '\${$HERMES_MODEL_KEY_ENV}'"
  info "  systemctl restart hermes-api"
elif [ "$DRY_RUN" = "1" ]; then
  info "would set model.provider=custom, model.base_url=$HERMES_MODEL_BASE_URL,"
  info "  model.default=$HERMES_MODEL_NAME, model.api_key=\${$HERMES_MODEL_KEY_ENV}"
elif [ -x "$HERMES_SRC/venv/bin/hermes" ]; then
  # The wrapper handles HOME/HERMES_HOME and the cwd; the key stays in .env via
  # the ${VAR} reference below. Guarded so a config failure warns instead of
  # aborting the install under `set -e` — Hermes is optional.
  if "$HERMES_WRAPPER" config set model.provider custom >/dev/null 2>&1 \
     && "$HERMES_WRAPPER" config set model.base_url "$HERMES_MODEL_BASE_URL" >/dev/null 2>&1 \
     && "$HERMES_WRAPPER" config set model.default "$HERMES_MODEL_NAME" >/dev/null 2>&1 \
     && "$HERMES_WRAPPER" config set model.api_key "\${$HERMES_MODEL_KEY_ENV}" >/dev/null 2>&1; then
    systemctl restart hermes-api 2>/dev/null || true
    ok "Hermes model -> $HERMES_MODEL_NAME via $HERMES_MODEL_BASE_URL (key: \$$HERMES_MODEL_KEY_ENV)"
  else
    warn "could not write Hermes' model config — set it by hand with 'hermes config set model.*' and restart hermes-api"
  fi
else
  warn "Hermes venv not built — skipping; re-run once the venv exists"
fi

# ── 9. wire Cartenz -> Hermes ──────────────────────────────────────────────────

step "9. Point Cartenz's default engine at Hermes"

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

# ── 10. verify ─────────────────────────────────────────────────────────────────

step "10. Verify"

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

  # Global hermes command resolves and hits the service config, not a fresh /root one.
  if command -v hermes >/dev/null 2>&1 && hermes --version >/dev/null 2>&1; then
    ok "hermes command works ($(hermes --version 2>/dev/null | head -1))"
  else
    warn "hermes command not resolving — check /usr/local/bin/hermes"
  fi
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

  1. Feed 9router at least one upstream model credential — THIS is what makes the
     agent able to think. Freshly installed, 9router's provider DB is empty, so
     Cartenz -> Hermes -> 9router answers "No active credentials for provider".
     Open the 9router UI (loopback :$ROUTER_PORT, reach it via SSH tunnel) and add a
     provider + API key (e.g. DeepSeek, Z.AI/GLM, Anthropic), then note the model id
     it actually serves — it is provider-prefixed (cc/claude-sonnet-5, ...):
       curl -s http://127.0.0.1:$ROUTER_PORT/v1/models

  2. Point Hermes' own brain at 9router. Hermes does NOT read AI_PROVIDER/AI_MODEL
     from .env for its own inference (those are Cartenz's keys); its model lives in
     ~/.hermes/config.yaml and is set with `hermes config set` — never by hand:
       hermes config set model.provider custom
       hermes config set model.base_url http://127.0.0.1:$ROUTER_PORT/v1
       hermes config set model.default  <a model id the gateway serves>
       hermes config set model.api_key  '\${$HERMES_MODEL_KEY_ENV}'   # key stays in .env
       systemctl restart hermes-api
     Step 8 does this for you when HERMES_MODEL_NAME is set. Confirm either way with:
       hermes -z "reply one word: PONG"     # expect: PONG

     Two traps that look like gateway failures but are not:
       - 401 far from here: config.yaml still points model.provider at anthropic.
       - "Permission denied: '/root/.hermes.md'": run the CLI from a readable dir;
         the installed wrapper cd's to $INSTALL_ROOT for this reason.

  3. Reverse proxy + TLS for the portal (:3000) and API (:4000) only.
     9router, Hermes ($HERMES_PORT), Postgres, Redis stay on loopback —
     never expose Hermes to the network. docs/INSTALL-SERVER.md §7.

  4. Portal -> Settings -> Model providers: keep Hermes for chat, and add a
     9router/Claude row BELOW it for change tasks (Hermes change planning
     fails its schema and fails over). Test each row.

  5. End-to-end check (should return real model text, not a provider error):
       curl -s http://127.0.0.1:$HERMES_PORT/health
       curl -s http://127.0.0.1:4000/api/v1/health/ready
       hermes -z "reply one word: PONG"

To replicate THIS laptop's Hermes config (providers, memories) instead of
keying fresh, copy it over once (secrets included — do it over SSH, not git):
  rsync -a --exclude cache --exclude logs ~/.hermes/  <vps>:$HERMES_HOME_DIR/
then: chown -R $SERVICE_USER:$SERVICE_USER $HERMES_HOME_DIR && systemctl restart hermes-api
────────────────────────────────────────────────────────────────
EOF
