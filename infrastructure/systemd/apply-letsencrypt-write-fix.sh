#!/usr/bin/env bash
# One-shot fix for ADR-069's first run (2026-09-29). Run as root:
#
#   sudo bash /opt/cartenz/infrastructure/systemd/apply-letsencrypt-write-fix.sh
#
# 1. Installs the systemd drop-ins that let certbot write under
#    ProtectSystem=strict (the "[Errno 30] Read-only file system:
#    /var/log/letsencrypt/.certbot.lock" failure).
# 2. Hands backend/dist back to the cartenz user so `npm run build` works
#    without root, then rebuilds the backend so the new worker code is served.
# 3. Restarts api + worker and prints the effective ReadWritePaths.
set -Eeuo pipefail

if [[ "$EUID" -ne 0 ]]; then
    echo "ERROR: run as root." >&2
    exit 1
fi

REPO=/opt/cartenz/infrastructure/systemd

for unit in cartenz-api cartenz-worker; do
    install -d -m 0755 "/etc/systemd/system/${unit}.service.d"
    install -m 0644 "${REPO}/${unit}.service.d/50-letsencrypt-write.conf" \
        "/etc/systemd/system/${unit}.service.d/50-letsencrypt-write.conf"
done

chown -R cartenz:cartenz /opt/cartenz/backend/dist
sudo -u cartenz bash -c 'cd /opt/cartenz/backend && npm run build'

systemctl daemon-reload
systemctl restart cartenz-api cartenz-worker

for unit in cartenz-api cartenz-worker; do
    echo "== ${unit}: $(systemctl is-active "$unit")"
    systemctl show "$unit" -p ReadWritePaths
done
