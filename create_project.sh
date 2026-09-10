#!/usr/bin/env bash

set -Eeuo pipefail

# ============================================================
# Odoo 19 - Generic Multi-Project Creator
# ============================================================
#
# Usage:
#   create_project <project_name> <http_port>
#
# Example:
#   create_project pipamas 9091
#
# Result:
#   Domain : dodol.masbintang.space
#   HTTP   : 9091
#   Gevent : 9092
#   DB     : dodol
#
# ============================================================

# ============================================================
# GLOBAL CONFIGURATION
# ============================================================

BASE_DOMAIN="masbintang.space"

BASE_DIR="/opt/odoo"

ODOO_DIR="${BASE_DIR}/odoo-server"
VENV_DIR="${BASE_DIR}/venv"
PROJECTS_DIR="${BASE_DIR}/projects"

ODOO_BIN="${ODOO_DIR}/odoo-bin"
PYTHON_BIN="${VENV_DIR}/bin/python"

ODOO_USER="odoo"
POSTGRES_USER="odoo"

SYSTEMD_DIR="/etc/systemd/system"

NGINX_AVAILABLE="/etc/nginx/sites-available"
NGINX_ENABLED="/etc/nginx/sites-enabled"

# ============================================================
# USAGE
# ============================================================

usage() {
    echo
    echo "Usage:"
    echo "  create_project <project_name> <http_port>"
    echo
    echo "Example:"
    echo "  create_project pipamas 9091"
    echo
    exit 1
}

# ============================================================
# ROOT CHECK
# ============================================================

if [[ "$EUID" -ne 0 ]]; then
    echo "ERROR: This script must be run as root."
    echo
    echo "Example:"
    echo "  sudo create_project pipamas 9091"
    exit 1
fi

# ============================================================
# ARGUMENTS
# ============================================================

if [[ $# -ne 2 ]]; then
    usage
fi

PROJECT_NAME="$1"
HTTP_PORT="$2"

GEVENT_PORT=$((HTTP_PORT + 1))

DOMAIN="${PROJECT_NAME}.${BASE_DOMAIN}"

PROJECT_DIR="${PROJECTS_DIR}/${PROJECT_NAME}"

CONFIG_DIR="${PROJECT_DIR}/config"
ADDONS_DIR="${PROJECT_DIR}/addons"
DATA_DIR="${PROJECT_DIR}/data"
LOG_DIR="${PROJECT_DIR}/logs"

CONFIG_FILE="${CONFIG_DIR}/odoo.conf"

SERVICE_NAME="odoo-${PROJECT_NAME}"
SERVICE_FILE="${SYSTEMD_DIR}/${SERVICE_NAME}.service"

NGINX_FILE="${NGINX_AVAILABLE}/${PROJECT_NAME}"
NGINX_LINK="${NGINX_ENABLED}/${PROJECT_NAME}"

DB_NAME="${PROJECT_NAME}"

# ============================================================
# COLORS / OUTPUT
# ============================================================

info() {
    echo "[INFO] $*"
}

success() {
    echo "[OK]   $*"
}

error() {
    echo "[ERROR] $*" >&2
}

# ============================================================
# VALIDATION
# ============================================================

info "Validating configuration..."

# Project name
if [[ ! "$PROJECT_NAME" =~ ^[a-z0-9][a-z0-9_-]{1,30}$ ]]; then
    error "Invalid project name."
    echo
    echo "Use only:"
    echo "  lowercase letters"
    echo "  numbers"
    echo "  -"
    echo "  _"
    echo
    exit 1
fi

# Domain
if [[ ! "$DOMAIN" =~ ^[a-z0-9.-]+$ ]]; then
    error "Generated domain is invalid: ${DOMAIN}"
    exit 1
fi

# HTTP port
if ! [[ "$HTTP_PORT" =~ ^[0-9]+$ ]]; then
    error "HTTP port must be numeric."
    exit 1
fi

if (( HTTP_PORT < 1024 || HTTP_PORT > 65534 )); then
    error "HTTP port must be between 1024 and 65534."
    exit 1
fi

# Gevent port
if (( GEVENT_PORT > 65535 )); then
    error "Gevent port is outside valid range."
    exit 1
fi

# ============================================================
# DISPLAY CONFIGURATION
# ============================================================

echo
echo "============================================================"
echo " Odoo 19 Project Creator"
echo "============================================================"
echo
echo "Project       : ${PROJECT_NAME}"
echo "Domain        : ${DOMAIN}"
echo "HTTP Port     : ${HTTP_PORT}"
echo "Gevent Port   : ${GEVENT_PORT}"
echo "Database      : ${DB_NAME}"
echo
echo "Odoo Source   : ${ODOO_DIR}"
echo "Python Venv   : ${VENV_DIR}"
echo "Project Dir   : ${PROJECT_DIR}"
echo
echo "============================================================"
echo

# ============================================================
# DEPENDENCY CHECKS
# ============================================================

info "Checking Odoo installation..."

if [[ ! -x "$PYTHON_BIN" ]]; then
    error "Shared Python not found:"
    echo "  ${PYTHON_BIN}"
    exit 1
fi

if [[ ! -x "$ODOO_BIN" ]]; then
    error "Odoo binary not found:"
    echo "  ${ODOO_BIN}"
    exit 1
fi

success "Shared Odoo + venv found."

# ============================================================
# USER CHECK
# ============================================================

if ! id "$ODOO_USER" >/dev/null 2>&1; then
    error "Linux user '${ODOO_USER}' does not exist."
    echo
    echo "Create it with:"
    echo "  useradd --system --home ${BASE_DIR} --shell /usr/sbin/nologin ${ODOO_USER}"
    exit 1
fi

success "Linux user '${ODOO_USER}' exists."

# ============================================================
# POSTGRESQL CHECK
# ============================================================

if ! command -v psql >/dev/null 2>&1; then
    error "PostgreSQL client is not installed."
    exit 1
fi

if ! systemctl is-active --quiet postgresql; then
    error "PostgreSQL service is not running."
    echo
    echo "Start it with:"
    echo "  systemctl enable --now postgresql"
    exit 1
fi

if ! runuser -u postgres -- psql -tAc \
    "SELECT 1 FROM pg_roles WHERE rolname='${POSTGRES_USER}'" \
    | grep -q 1; then

    error "PostgreSQL role '${POSTGRES_USER}' does not exist."
    echo
    echo "Create it with:"
    echo "  sudo -u postgres createuser --createdb ${POSTGRES_USER}"
    exit 1
fi

success "PostgreSQL is ready."

# ============================================================
# PROJECT EXISTENCE CHECK
# ============================================================

if [[ -e "$PROJECT_DIR" ]]; then
    error "Project already exists:"
    echo "  ${PROJECT_DIR}"
    exit 1
fi

if [[ -e "$SERVICE_FILE" ]]; then
    error "Systemd service already exists:"
    echo "  ${SERVICE_FILE}"
    exit 1
fi

if [[ -e "$NGINX_FILE" ]]; then
    error "Nginx configuration already exists:"
    echo "  ${NGINX_FILE}"
    exit 1
fi

if [[ -e "$NGINX_LINK" ]]; then
    error "Nginx symlink already exists:"
    echo "  ${NGINX_LINK}"
    exit 1
fi

# ============================================================
# PORT CHECK
# ============================================================

if ss -ltn | awk '{print $4}' | grep -qE ":${HTTP_PORT}$"; then
    error "HTTP port ${HTTP_PORT} is already in use."
    exit 1
fi

if ss -ltn | awk '{print $4}' | grep -qE ":${GEVENT_PORT}$"; then
    error "Gevent port ${GEVENT_PORT} is already in use."
    exit 1
fi

success "Ports ${HTTP_PORT} and ${GEVENT_PORT} are available."

# ============================================================
# DATABASE CHECK
# ============================================================

if runuser -u postgres -- psql -tAc \
    "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" \
    | grep -q 1; then

    error "PostgreSQL database '${DB_NAME}' already exists."
    exit 1
fi

# ============================================================
# CLEANUP / ROLLBACK
# ============================================================

CREATED_DB=false
CREATED_PROJECT=false
CREATED_SERVICE=false
CREATED_NGINX=false
CREATED_NGINX_LINK=false

cleanup() {

    local exit_code=$?

    if (( exit_code == 0 )); then
        return
    fi

    echo
    echo "============================================================"
    echo " ERROR DETECTED - CLEANUP"
    echo "============================================================"

    systemctl stop "$SERVICE_NAME" 2>/dev/null || true
    systemctl disable "$SERVICE_NAME" 2>/dev/null || true

    if [[ "$CREATED_SERVICE" == true ]]; then
        rm -f "$SERVICE_FILE"
    fi

    if [[ "$CREATED_NGINX_LINK" == true ]]; then
        rm -f "$NGINX_LINK"
    fi

    if [[ "$CREATED_NGINX" == true ]]; then
        rm -f "$NGINX_FILE"
    fi

    if [[ "$CREATED_DB" == true ]]; then
        runuser -u postgres -- dropdb "$DB_NAME" 2>/dev/null || true
    fi

    if [[ "$CREATED_PROJECT" == true ]]; then
        rm -rf "$PROJECT_DIR"
    fi

    systemctl daemon-reload 2>/dev/null || true

    echo
    echo "Cleanup completed."
    echo

    exit "$exit_code"
}

trap cleanup EXIT

# ============================================================
# CREATE PROJECT DIRECTORIES
# ============================================================

info "Creating project directories..."

mkdir -p \
    "$CONFIG_DIR" \
    "$ADDONS_DIR" \
    "$DATA_DIR" \
    "$LOG_DIR"

chown -R "${ODOO_USER}:${ODOO_USER}" "$PROJECT_DIR"

chmod 750 "$PROJECT_DIR"
chmod 750 "$CONFIG_DIR"
chmod 750 "$ADDONS_DIR"
chmod 750 "$DATA_DIR"
chmod 750 "$LOG_DIR"

CREATED_PROJECT=true

success "Project directories created."

# ============================================================
# CREATE DATABASE
# ============================================================

info "Creating PostgreSQL database..."

runuser -u postgres -- createdb \
    --owner="$POSTGRES_USER" \
    "$DB_NAME"

CREATED_DB=true

success "Database '${DB_NAME}' created."

# ============================================================
# GENERATE MASTER PASSWORD
# ============================================================

info "Generating Odoo master password..."

if ! command -v openssl >/dev/null 2>&1; then
    error "openssl is required."
    exit 1
fi

MASTER_PASSWORD="$(openssl rand -hex 32)"

# ============================================================
# CREATE ODOO CONFIG
# ============================================================

info "Creating Odoo configuration..."

cat > "$CONFIG_FILE" <<EOF
[options]

; ==========================================================
; Odoo
; ==========================================================

admin_passwd = ${MASTER_PASSWORD}

http_interface = 127.0.0.1
http_port = ${HTTP_PORT}
gevent_port = ${GEVENT_PORT}

proxy_mode = True

; ==========================================================
; Database
; ==========================================================

; db_host =
; db_port =
db_user = ${POSTGRES_USER}
; db_password =

db_name = ${DB_NAME}
dbfilter = ^${DB_NAME}\$

list_db = False

; ==========================================================
; Addons
; ==========================================================

addons_path = ${ODOO_DIR}/addons,${ADDONS_DIR}

; ==========================================================
; Data
; ==========================================================

data_dir = ${DATA_DIR}

; ==========================================================
; Workers
; ==========================================================

workers = 2
max_cron_threads = 1

; ==========================================================
; Resource Limits
; ==========================================================

limit_request = 8192
limit_time_cpu = 120
limit_time_real = 240

limit_memory_soft = 2147483648
limit_memory_hard = 2684354560

; ==========================================================
; Logging
; ==========================================================

logfile = ${LOG_DIR}/odoo.log
log_level = info
EOF

chown root:"$ODOO_USER" "$CONFIG_FILE"
chmod 640 "$CONFIG_FILE"

success "Odoo configuration created."

# ============================================================
# INITIALIZE ODOO DATABASE
# ============================================================

info "Initializing Odoo database..."

runuser -u "$ODOO_USER" -- \
    "$PYTHON_BIN" "$ODOO_BIN" \
    -c "$CONFIG_FILE" \
    -d "$DB_NAME" \
    -i base \
    --without-demo=all \
    --stop-after-init

success "Odoo database initialized."

# ============================================================
# CREATE SYSTEMD SERVICE
# ============================================================

info "Creating systemd service..."

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Odoo 19 - ${PROJECT_NAME}
Documentation=https://www.odoo.com/documentation/19.0/
After=network.target postgresql.service
Requires=postgresql.service

[Service]
Type=simple

User=${ODOO_USER}
Group=${ODOO_USER}

WorkingDirectory=${ODOO_DIR}

ExecStart=${PYTHON_BIN} ${ODOO_BIN} -c ${CONFIG_FILE}

Restart=always
RestartSec=5

TimeoutStartSec=0
TimeoutStopSec=30

KillMode=mixed

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true

ReadWritePaths=${PROJECT_DIR}

StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

chmod 644 "$SERVICE_FILE"

CREATED_SERVICE=true

systemctl daemon-reload

success "Systemd service created."

# ============================================================
# NGINX
# ============================================================

if command -v nginx >/dev/null 2>&1; then

    info "Creating Nginx configuration..."

    mkdir -p "$NGINX_AVAILABLE" "$NGINX_ENABLED"

    cat > "$NGINX_FILE" <<EOF
upstream odoo_${PROJECT_NAME} {
    server 127.0.0.1:${HTTP_PORT};
}

upstream odoo_${PROJECT_NAME}_gevent {
    server 127.0.0.1:${GEVENT_PORT};
}

server {

    listen 80;
    server_name ${DOMAIN};

    proxy_read_timeout 720s;
    proxy_connect_timeout 720s;
    proxy_send_timeout 720s;

    client_max_body_size 200m;

    access_log /var/log/nginx/odoo-${PROJECT_NAME}.access.log;
    error_log /var/log/nginx/odoo-${PROJECT_NAME}.error.log;

    # ======================================================
    # WebSocket
    # ======================================================

    location /websocket {

        proxy_pass http://odoo_${PROJECT_NAME}_gevent;

        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;

        proxy_set_header X-Forwarded-Host \$http_host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Real-IP \$remote_addr;

        proxy_redirect off;
    }

    # ======================================================
    # Odoo HTTP
    # ======================================================

    location / {

        proxy_pass http://odoo_${PROJECT_NAME};

        proxy_set_header X-Forwarded-Host \$http_host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Real-IP \$remote_addr;

        proxy_redirect off;
    }
}
EOF

    CREATED_NGINX=true

    ln -s "$NGINX_FILE" "$NGINX_LINK"

    CREATED_NGINX_LINK=true

    success "Nginx configuration created."

    # --------------------------------------------------------
    # Check global websocket map
    # --------------------------------------------------------

    if ! nginx -T 2>/dev/null | grep -q 'map \$http_upgrade \$connection_upgrade'; then

        echo
        echo "WARNING: Nginx websocket map was not found."
        echo
        echo "Add this inside the 'http {' block of:"
        echo
        echo "  /etc/nginx/nginx.conf"
        echo
        echo "  map \$http_upgrade \$connection_upgrade {"
        echo "      default upgrade;"
        echo "      ''      close;"
        echo "  }"
        echo

    fi

    info "Testing Nginx configuration..."

    if ! nginx -t; then
        error "Nginx configuration test failed."
        exit 1
    fi

    systemctl reload nginx

    success "Nginx configuration is valid."

else

    echo
    echo "WARNING: Nginx is not installed."
    echo
    echo "Install it with:"
    echo
    echo "  apt install -y nginx"
    echo

fi

# ============================================================
# ENABLE & START ODOO
# ============================================================

info "Enabling Odoo service..."

systemctl enable "$SERVICE_NAME"

info "Starting Odoo service..."

systemctl start "$SERVICE_NAME"

sleep 3

# ============================================================
# SERVICE CHECK
# ============================================================

if ! systemctl is-active --quiet "$SERVICE_NAME"; then

    error "Odoo service failed to start."

    echo
    echo "Last logs:"
    echo

    journalctl \
        -u "$SERVICE_NAME" \
        -n 50 \
        --no-pager

    exit 1
fi

success "Odoo service is running."

# ============================================================
# FINAL OUTPUT
# ============================================================

echo
echo "============================================================"
echo " PROJECT CREATED SUCCESSFULLY"
echo "============================================================"
echo
echo "Project:"
echo "  ${PROJECT_NAME}"
echo
echo "Domain:"
echo "  http://${DOMAIN}"
echo
echo "Database:"
echo "  ${DB_NAME}"
echo
echo "HTTP:"
echo "  127.0.0.1:${HTTP_PORT}"
echo
echo "Gevent/WebSocket:"
echo "  127.0.0.1:${GEVENT_PORT}"
echo
echo "Project directory:"
echo "  ${PROJECT_DIR}"
echo
echo "Config:"
echo "  ${CONFIG_FILE}"
echo
echo "Logs:"
echo "  ${LOG_DIR}/odoo.log"
echo
echo "Systemd:"
echo "  ${SERVICE_NAME}"
echo
echo "Nginx:"
echo "  ${NGINX_FILE}"
echo
echo "============================================================"
echo
echo "Odoo Master Password:"
echo
echo "  ${MASTER_PASSWORD}"
echo
echo "============================================================"
echo
echo "IMPORTANT:"
echo
echo "Save the Odoo Master Password securely."
echo
echo "DNS:"
echo "  ${DOMAIN} -> VPS IP"
echo
echo "After DNS is active, setup HTTPS/SSL."
echo
echo "============================================================"
echo