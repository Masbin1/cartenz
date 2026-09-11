#!/usr/bin/env bash
set -Eeuo pipefail

# ============================================================
# LinkedERP - HTTPS issuance for a provisioned Odoo project (ADR-040)
# ============================================================
#
# Runs as root (via the narrow sudoers rule in
# infrastructure/provisioning/99-linkederp-provisioning), immediately after
# create_project / create_project_enterprise has provisioned a project and its
# plain-HTTP Nginx site is live.
#
# This does exactly what an operator would type by hand to switch a freshly
# provisioned project from HTTP to HTTPS:
#
#   certbot --nginx -d <name>.<base-domain> --non-interactive --agree-tos
#     -m <email> --redirect
#
# certbot's nginx plugin edits the site file in place (adds `listen 443 ssl`,
# the certificate directives, and a 80->443 redirect block), reloads Nginx
# itself, and manages renewal via the system certbot timer/cron already
# installed on this host - nothing here duplicates that.
#
# Usage:
#   setup-project-https <project_name> <email>
#
# Example:
#   setup-project-https dodolbintangmas ops@example.com
#
# Exit code is certbot's own: 0 on success, non-zero otherwise. Never touches
# the database, the systemd unit or any file this platform did not already
# create by way of create_project.
# ============================================================

BASE_DOMAIN_FILE_HINT="(the caller passes the full domain and email; nothing is derived here)"

usage() {
    echo
    echo "Usage:"
    echo "  setup-project-https <project_name> <domain> <email>"
    echo
    echo "Example:"
    echo "  setup-project-https dodolbintangmas dodolbintangmas.masbintang.space ops@example.com"
    echo
    exit 1
}

if [[ "$EUID" -ne 0 ]]; then
    echo "ERROR: This script must be run as root." >&2
    exit 1
fi

if [[ $# -ne 3 ]]; then
    usage
fi

PROJECT_NAME="$1"
DOMAIN="$2"
EMAIL="$3"

if [[ ! "$PROJECT_NAME" =~ ^[a-z0-9][a-z0-9_-]{1,30}$ ]]; then
    echo "ERROR: Invalid project name." >&2
    exit 1
fi

if [[ ! "$DOMAIN" =~ ^[a-z0-9.-]+$ ]]; then
    echo "ERROR: Invalid domain: ${DOMAIN}" >&2
    exit 1
fi

if [[ ! "$EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; then
    echo "ERROR: Invalid email: ${EMAIL}" >&2
    exit 1
fi

NGINX_FILE="/etc/nginx/sites-available/${PROJECT_NAME}"

if [[ ! -f "$NGINX_FILE" ]]; then
    echo "ERROR: No Nginx site found for '${PROJECT_NAME}' at ${NGINX_FILE}." >&2
    echo "Run create_project/create_project_enterprise first." >&2
    exit 1
fi

# The domain in the request must actually be the one create_project wrote for
# this project - refuses a caller trying to issue a certificate for a domain
# this project's own Nginx site does not serve.
if ! grep -qE "server_name[[:space:]]+${DOMAIN}[[:space:]]*;" "$NGINX_FILE"; then
    echo "ERROR: ${DOMAIN} is not the server_name in ${NGINX_FILE}." >&2
    exit 1
fi

if ! command -v certbot >/dev/null 2>&1; then
    echo "ERROR: certbot is not installed." >&2
    echo "Install it with: apt install -y certbot python3-certbot-nginx" >&2
    exit 1
fi

echo "[INFO] Requesting a certificate for ${DOMAIN}..."

certbot --nginx \
    -d "$DOMAIN" \
    --non-interactive \
    --agree-tos \
    -m "$EMAIL" \
    --redirect

echo "[OK] HTTPS is live for ${DOMAIN}."
