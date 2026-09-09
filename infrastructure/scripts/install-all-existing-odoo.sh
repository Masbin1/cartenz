#!/usr/bin/env bash
#
# One-shot installer for a server that ALREADY runs Odoo.
#
#   sudo ./infrastructure/scripts/install-all-existing-odoo.sh
#
# It orchestrates the pieces you would otherwise run by hand:
#
#   1. install-server.sh        -> platform (packages, DB, build, 9router, units)
#   2. read access to Odoo       -> the cartenz user joins the Odoo group
#   3. a writable projects root   -> owned by cartenz, separate from Odoo's own
#   4. the Odoo path block in .env -> base/enterprise/venv/runtime, as the
#                                     pre-portal fallback (INSTALL-SERVER-EXISTING-ODOO.md)
#   5. (optional) validation role -> WITH_VALIDATION=1
#
# It does NOT install Hermes. Hermes is optional and slow (~12 min/call); Cartenz
# runs fine against 9router/Claude alone. Add it later per the server guide §6 if
# you want its per-project memory.
#
# It is idempotent: paths are validated first, install-server.sh skips what it
# already made, and each .env key is upserted (replaced in place, never
# duplicated). Nothing here writes to Odoo's own files — the golden rule is that
# Cartenz READS the Odoo source and never owns it.
#
# Environment overrides:
#
#   ODOO_BASE_DIR      Odoo estate root          (default /opt/odoo)
#   ODOO_SOURCE_ROOT   repo root holding odoo-bin(default $ODOO_BASE_DIR/odoo-server)
#   ODOO_ENTERPRISE    enterprise addons dir     (default $ODOO_BASE_DIR/enterprise)
#   ODOO_VENV_PYTHON   interpreter for validation(default $ODOO_BASE_DIR/venv/bin/python)
#   ODOO_SERIES        Odoo version series       (default 19.0)
#   ODOO_GROUP         group that can read Odoo   (default odoo)
#   CARTENZ_PROJECTS   writable projects root     (default /opt/cartenz-projects)
#   INSTALL_ROOT       where Cartenz lives        (default /opt/cartenz)
#   SERVICE_USER       account services run as    (default cartenz)
#   WITH_ENTERPRISE    =0 to exclude enterprise   (default 1)
#   WITH_VALIDATION    =1 to create the validation role and enable validation
#   DRY_RUN            =1 to print the plan and change nothing
#
# All install-server.sh overrides (DB_NAME, DB_USER, REPO_URL, SKIP_PACKAGES...)
# are honoured too — they pass straight through.
set -euo pipefail

ODOO_BASE_DIR="${ODOO_BASE_DIR:-/opt/odoo}"
ODOO_SOURCE_ROOT="${ODOO_SOURCE_ROOT:-$ODOO_BASE_DIR/odoo-server}"
ODOO_ENTERPRISE="${ODOO_ENTERPRISE:-$ODOO_BASE_DIR/enterprise}"
ODOO_VENV_PYTHON="${ODOO_VENV_PYTHON:-$ODOO_BASE_DIR/venv/bin/python}"
ODOO_SERIES="${ODOO_SERIES:-19.0}"
ODOO_GROUP="${ODOO_GROUP:-odoo}"
CARTENZ_PROJECTS="${CARTENZ_PROJECTS:-/opt/cartenz-projects}"
INSTALL_ROOT="${INSTALL_ROOT:-/opt/cartenz}"
SERVICE_USER="${SERVICE_USER:-cartenz}"
WITH_ENTERPRISE="${WITH_ENTERPRISE:-1}"
WITH_VALIDATION="${WITH_VALIDATION:-0}"
DRY_RUN="${DRY_RUN:-0}"

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

# ── preflight ──────────────────────────────────────────────────────────────────

step "Preflight"

[ "$(id -u)" = "0" ] || fail "Run as root: sudo $0"

SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
SCRIPTS_DIR="$(dirname "$SCRIPT_PATH")"
SOURCE_ROOT="$(cd "$SCRIPTS_DIR/../.." && pwd)"

INSTALLER="$SCRIPTS_DIR/install-server.sh"
[ -x "$INSTALLER" ] || fail "install-server.sh not found next to this script ($INSTALLER)"
ok "platform installer $INSTALLER"

if [ "$DRY_RUN" = "1" ]; then
  warn "DRY_RUN=1 — nothing will be changed."
fi

# Validate the Odoo estate before touching the platform. A wrong path here is a
# task-time failure; catching it now is the whole point of this wrapper.
step "Validate the existing Odoo estate"

[ -f "$ODOO_SOURCE_ROOT/odoo-bin" ] || fail \
  "No odoo-bin at $ODOO_SOURCE_ROOT. base_path must be the repo ROOT holding odoo-bin, not its addons/ subfolder. Override with ODOO_SOURCE_ROOT=..."
ok "base source $ODOO_SOURCE_ROOT (odoo-bin present)"

[ -x "$ODOO_VENV_PYTHON" ] || fail \
  "Odoo venv interpreter not executable at $ODOO_VENV_PYTHON. Override with ODOO_VENV_PYTHON=..."
ok "venv python $ODOO_VENV_PYTHON"

ENTERPRISE_ACTIVE=0
if [ "$WITH_ENTERPRISE" = "1" ]; then
  if [ -d "$ODOO_ENTERPRISE" ]; then
    ENTERPRISE_ACTIVE=1
    ok "enterprise $ODOO_ENTERPRISE"
  else
    warn "enterprise dir $ODOO_ENTERPRISE not found — continuing as Community (set ODOO_ENTERPRISE=... or WITH_ENTERPRISE=0)"
  fi
else
  skip "WITH_ENTERPRISE=0 — enterprise excluded from source paths"
fi

if getent group "$ODOO_GROUP" >/dev/null 2>&1; then
  ok "read-access group $ODOO_GROUP exists"
else
  warn "group $ODOO_GROUP does not exist — the cartenz user may not be able to read the Odoo source; set ODOO_GROUP=... to the owner of $ODOO_SOURCE_ROOT"
fi

# Build the comma-joined source path list once, reused for .env below.
if [ "$ENTERPRISE_ACTIVE" = "1" ]; then
  SOURCE_PATHS="$ODOO_SOURCE_ROOT,$ODOO_ENTERPRISE"
  SHARED_ADDONS="$ODOO_ENTERPRISE"
else
  SOURCE_PATHS="$ODOO_SOURCE_ROOT"
  SHARED_ADDONS=""
fi
RUNTIMES="$ODOO_SERIES=$ODOO_SOURCE_ROOT"

info "source paths  : $SOURCE_PATHS"
info "runtimes      : $RUNTIMES"
info "projects root : $CARTENZ_PROJECTS"

# ── 1. platform ────────────────────────────────────────────────────────────────

step "1. Install the Cartenz platform"
info "delegating to install-server.sh (packages, DB, build, 9router, systemd)"

# Pass DRY_RUN and any install-server overrides straight through the environment.
run env INSTALL_ROOT="$INSTALL_ROOT" SERVICE_USER="$SERVICE_USER" DRY_RUN="$DRY_RUN" \
  bash "$INSTALLER"

ENV_FILE="$INSTALL_ROOT/.env"

# ── 2. read access to the Odoo source ──────────────────────────────────────────

step "2. Grant the $SERVICE_USER user read access to the Odoo source"

if getent group "$ODOO_GROUP" >/dev/null 2>&1; then
  if id -nG "$SERVICE_USER" 2>/dev/null | tr ' ' '\n' | grep -qx "$ODOO_GROUP"; then
    skip "$SERVICE_USER already in group $ODOO_GROUP"
  else
    run usermod -aG "$ODOO_GROUP" "$SERVICE_USER"
    ok "added $SERVICE_USER to group $ODOO_GROUP (re-login/worker restart applies it)"
  fi
  info "Cartenz reads this source; it never owns or writes it. Do NOT chown Odoo files to $SERVICE_USER."
else
  warn "skipped — group $ODOO_GROUP missing. Ensure $SERVICE_USER can read $ODOO_SOURCE_ROOT by other means."
fi

# ── 3. writable projects root ──────────────────────────────────────────────────

step "3. Create the writable projects root"

if [ -d "$CARTENZ_PROJECTS" ]; then
  skip "$CARTENZ_PROJECTS exists"
else
  run mkdir -p "$CARTENZ_PROJECTS"
  ok "created $CARTENZ_PROJECTS"
fi
run chown "$SERVICE_USER:$SERVICE_USER" "$CARTENZ_PROJECTS"
ok "$CARTENZ_PROJECTS owned by $SERVICE_USER (the only writable Odoo path per project)"

# ── 4. Odoo path block in .env ─────────────────────────────────────────────────

step "4. Write the Odoo path block into .env"

if [ "$DRY_RUN" = "1" ]; then
  info "would upsert into $ENV_FILE:"
  info "  ODOO_SOURCE_PATHS=$SOURCE_PATHS"
  info "  ON_PREMISE_ROOT=$CARTENZ_PROJECTS"
  info "  ON_PREMISE_READ_ONLY_PATHS=$SOURCE_PATHS"
  info "  ODOO_RUNTIMES=$RUNTIMES"
  info "  ODOO_SHARED_ADDON_PATHS=$SHARED_ADDONS"
  info "  ODOO_PYTHON=$ODOO_VENV_PYTHON"
else
  [ -f "$ENV_FILE" ] || fail "$ENV_FILE not found — did the platform install step run?"

  # Replace the key in place if present, else append. grep -v on a fixed,
  # simple key name is safe regardless of what characters the value holds.
  upsert_env() {
    local key="$1" val="$2" tmp
    tmp="$(mktemp)"
    grep -vE "^${key}=" "$ENV_FILE" > "$tmp" || true
    printf '%s=%s\n' "$key" "$val" >> "$tmp"
    cat "$tmp" > "$ENV_FILE"
    rm -f "$tmp"
  }

  upsert_env ODOO_SOURCE_PATHS         "$SOURCE_PATHS"
  upsert_env ON_PREMISE_ROOT           "$CARTENZ_PROJECTS"
  upsert_env ON_PREMISE_READ_ONLY_PATHS "$SOURCE_PATHS"
  upsert_env ODOO_RUNTIMES             "$RUNTIMES"
  upsert_env ODOO_SHARED_ADDON_PATHS   "$SHARED_ADDONS"
  upsert_env ODOO_PYTHON               "$ODOO_VENV_PYTHON"

  chmod 600 "$ENV_FILE"
  chown "$SERVICE_USER:$SERVICE_USER" "$ENV_FILE"
  ok "Odoo paths written to $ENV_FILE (mode 600)"
fi

# ── 5. (optional) validation role ──────────────────────────────────────────────

step "5. Validation role"

if [ "$WITH_VALIDATION" != "1" ]; then
  skip "WITH_VALIDATION not set — validation stays disabled (reported as skipped, never faked)"
  info "Enable later: sudo WITH_VALIDATION=1 $0   (or run create-validation-role.sh and set VALIDATION_* in .env)"
elif [ "$DRY_RUN" = "1" ]; then
  info "would run: $SCRIPTS_DIR/create-validation-role.sh, then set VALIDATION_ENABLED=true in .env"
else
  info "creating linkederp_validation and closing CONNECT on non-platform databases"
  ODOO_ROLE="$ODOO_GROUP" bash "$SCRIPTS_DIR/create-validation-role.sh"
  warn "The validation password was printed above ONCE. Copy VALIDATION_DB_USER/PASSWORD into:"
  info "  $ENV_FILE  (VALIDATION_ENABLED=true, VALIDATION_DB_USER=..., VALIDATION_DB_PASSWORD=...)"
  info "Then: systemctl restart cartenz-worker"
fi

# ── summary ────────────────────────────────────────────────────────────────────

cat <<EOF

────────────────────────────────────────────────────────────────
Cartenz installed at $INSTALL_ROOT and wired to the Odoo estate at $ODOO_BASE_DIR.

Odoo paths (pre-portal fallback, now in .env):
  base source   : $ODOO_SOURCE_ROOT
  enterprise    : $([ "$ENTERPRISE_ACTIVE" = "1" ] && echo "$ODOO_ENTERPRISE" || echo "(none — Community)")
  venv python   : $ODOO_VENV_PYTHON
  runtimes      : $RUNTIMES
  projects root : $CARTENZ_PROJECTS  (writable, owned by $SERVICE_USER)

Hermes was NOT installed (optional, slow). Cartenz uses 9router/Claude alone.

Next, in this order:

  1. Reverse proxy + TLS in front of the portal (:3000) and API (:4000).
     Everything else — 9router, Postgres, Redis — stays on loopback.
     See docs/INSTALL-SERVER.md §7.

  2. Open the portal, register the first account (it owns the organisation),
     then Settings → Model providers: add 9router/Claude at priority 1 and
     Test each row. A model that refuses a strict json_schema must have
     structured outputs OFF, or planning calls hang.

  3. Settings → Odoo: set base=$ODOO_SOURCE_ROOT, enterprise, projects_root
     to the same values above. The portal becomes the authority once saved;
     the .env block is the fallback until then.

  4. Verify:
       curl -s http://127.0.0.1:4000/api/v1/health/ready
       curl -s http://127.0.0.1:4000/api/v1/health/posture | python3 -m json.tool

Full detail: docs/guides/server-setup-from-scratch.md
             docs/INSTALL-SERVER-EXISTING-ODOO.md
────────────────────────────────────────────────────────────────
EOF
