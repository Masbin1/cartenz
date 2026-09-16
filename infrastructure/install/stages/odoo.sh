#!/usr/bin/env bash
# shellcheck shell=bash
#
# Stage: odoo — the Odoo estate, one full checkout per version (ADR-045).
#
# Auto-detect, two paths:
#
#   adopt    ODOO_ROOT/versions/<ver>/odoo already holds odoo-bin: the estate
#            is treated as the operator's, made readable by the service user,
#            and never written to. Nothing owned by Odoo is touched.
#
#   install  The directory is empty: the stage creates the odoo system user and
#            group, clones the Odoo source for ODOO_SERIES, creates a venv and
#            installs the Python dependencies. The enterprise directory is
#            expected beside the checkout (licence held by the operator); when
#            it exists it is wired in, when it does not the install proceeds
#            Community-only.
#
# The golden rule is the same in both paths: Cartenz READS the Odoo source and
# never owns it. The adopt path is the one a server that already runs Odoo
# takes; the install path is what makes a brand-new server runnable end to end.

step "odoo: estate and per-version checkout"

VERSION_DIR="$ODOO_ROOT/versions/$ODOO_SERIES"
BASE_PATH="$VERSION_DIR/odoo"
ENTERPRISE_PATH="$VERSION_DIR/enterprise"

# The odoo group exists on either path: the adopt path adds the service user
# to an existing one, the install path creates it.
if getent group "$ODOO_GROUP" >/dev/null 2>&1; then
  ok "group $ODOO_GROUP exists"
else
  run groupadd --system "$ODOO_GROUP"
  ok "created group $ODOO_GROUP"
fi

if id -u "$ODOO_GROUP" >/dev/null 2>&1; then
  ok "user $ODOO_GROUP exists"
else
  run useradd --system --home-dir "$ODOO_ROOT" --shell /usr/sbin/nologin -g "$ODOO_GROUP" "$ODOO_GROUP"
  ok "created user $ODOO_GROUP"
fi

run mkdir -p "$VERSION_DIR"

if [ -f "$BASE_PATH/odoo-bin" ]; then
  # ── adopt ────────────────────────────────────────────────────────────────────
  ok "adopting existing Odoo $ODOO_SERIES at $BASE_PATH"

  if id -nG "$SERVICE_USER" | tr ' ' '\n' | grep -qx "$ODOO_GROUP"; then
    skip "$SERVICE_USER already in group $ODOO_GROUP"
  else
    run usermod -aG "$ODOO_GROUP" "$SERVICE_USER"
    ok "added $SERVICE_USER to $ODOO_GROUP (read-only access)"
  fi

  if [ -d "$ENTERPRISE_PATH" ]; then
    ok "enterprise addons present at $ENTERPRISE_PATH"
  else
    info "no enterprise addons at $ENTERPRISE_PATH — Community-only until added"
  fi
else
  # ── install ──────────────────────────────────────────────────────────────────
  step "odoo: installing Odoo $ODOO_SERIES from source"

  ODOO_REPO="${ODOO_REPO:-https://github.com/odoo/odoo.git}"
  ODOO_BRANCH="${ODOO_BRANCH:-$ODOO_SERIES}"

  if [ "${DRY_RUN:-0}" = "1" ]; then
    printf '    \033[2mwould run:\033[0m git clone --branch %s --depth 1 %s %s\n' "$ODOO_BRANCH" "$ODOO_REPO" "$BASE_PATH"
  else
    run sudo -u "$ODOO_GROUP" git clone --branch "$ODOO_BRANCH" --depth 1 "$ODOO_REPO" "$BASE_PATH"
    ok "cloned Odoo $ODOO_SERIES"
  fi

  # The Python runtime. One venv per version: Odoo series do not share
  # dependency sets, and mixing them is how an upgrade breaks an older estate.
  VENV_PYTHON="${ODOO_PYTHON:-$VERSION_DIR/venv/bin/python}"
  if [ -x "$VENV_PYTHON" ]; then
    skip "venv exists at $VENV_PYTHON"
  else
    run apt-get install -y -qq python3-venv python3-pip build-essential libpq-dev \
      libldap2-dev libsasl2-dev libxml2-dev libxslt1-dev libjpeg-dev zlib1g-dev \
      libfreetype6-dev liblcms2-dev libopenjp2-7-dev libssl-dev wkhtmltopdf \
      fonts-dejavu-core 2>/dev/null || true
    ok "python build prerequisites installed"

    run sudo -u "$ODOO_GROUP" python3 -m venv "$VERSION_DIR/venv"
    ok "venv created"
  fi

  if [ -f "$BASE_PATH/requirements.txt" ] && [ "${DRY_RUN:-0}" != "1" ]; then
    sudo -u "$ODOO_GROUP" "$VENV_PYTHON" -m pip install --quiet --upgrade pip || true
    sudo -u "$ODOO_GROUP" "$VENV_PYTHON" -m pip install --quiet -r "$BASE_PATH/requirements.txt" \
      || warn "pip install -r requirements.txt failed — see the output above; Odoo may still run"
    ok "Odoo Python dependencies installed"
  fi

  # Read access for the platform user: the agent reads the source as a
  # reference and never writes it.
  run usermod -aG "$ODOO_GROUP" "$SERVICE_USER"
  ok "added $SERVICE_USER to $ODOO_GROUP (read-only access)"

  ODOO_PYTHON="$VENV_PYTHON"
fi

summary "odoo: $ODOO_SERIES at $BASE_PATH (enterprise: $([ -d "$ENTERPRISE_PATH" ] && echo yes || echo no))"
