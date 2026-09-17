#!/usr/bin/env bash
#
# LinkedERP estate monitor (ADR-056 in the operator's register, item 3).
#
# A read-only health check for the whole estate on this host: the platform's own
# units, every provisioned Odoo instance, disk headroom, and the certificate
# renewal timer. Run it from cron, a systemd timer, or by hand. It changes
# nothing and needs no root: everything it reads (systemd state, listening
# ports, disk usage, the logs directory) is readable as the platform user.
#
# Exit code: 0 when everything it checks is healthy, 1 when anything is not.
# The output is one line per check - `OK`/`WARN`/`FAIL` - so a cron wrapper can
# alert on the exit code and a person can read the lines.
#
# What it does NOT cover (install separately, as root - see the runbook in
# docs/architecture/client-estate-and-server-architecture.md 4.4):
#   - OS security updates: unattended-upgrades for the security pocket
#   - alert delivery: mail/chat routing for a non-zero exit
#   - per-instance log rotation beyond the platform's own logrotate rule
set -uo pipefail

FAIL=0
WARN=0

ok()   { echo "  OK    $1"; }
warn() { echo "  WARN  $1"; WARN=$((WARN + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

check_unit() {
  local unit="$1" label="$2"
  local load
  load="$(systemctl show "$unit" -p LoadState --value 2>/dev/null)"
  if [[ "$load" != "loaded" ]]; then
    fail "$label: unit $unit not found"
    return
  fi
  local state
  state="$(systemctl is-active "$unit" 2>/dev/null || true)"
  if [[ "$state" == "active" ]]; then
    ok "$label: $unit active"
  else
    fail "$label: $unit is $state"
  fi
}

echo "LinkedERP estate monitor - $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo
echo "Platform units"
for unit in cartenz-api cartenz-worker cartenz-portal 9router hermes-api nginx postgresql; do
  check_unit "$unit" "platform"
done

echo
echo "Provisioned Odoo instances"
mapfile -t ODOO_UNITS < <(systemctl list-units --type=service --all --no-pager 2>/dev/null \
  | awk '{print $1}' | grep -E '^odoo-' | sort -u)
if [[ "${#ODOO_UNITS[@]}" -eq 0 ]]; then
  warn "no odoo-* units found; is anything provisioned on this host?"
else
  for unit in "${ODOO_UNITS[@]}"; do
    # A unit merely listed is not a unit that exists: e.g. `odoo-<name>.service`
    # with state not-found is a leftover reference, not an instance.
    if [[ "$(systemctl show "$unit" -p LoadState --value 2>/dev/null)" != "loaded" ]]; then
      warn "stale unit reference: $unit (not loaded)"
      continue
    fi
    state="$(systemctl is-active "$unit" 2>/dev/null || true)"
    if [[ "$state" == "active" ]]; then
      ok "$unit active"
    else
      fail "$unit is $state"
    fi
  done
fi

echo
echo "Disk headroom"
for mount in / /var /opt; do
  [[ -d "$mount" ]] || continue
  used_pct="$(df --output=pcent "$mount" 2>/dev/null | tail -1 | tr -dc '0-9')"
  [[ -n "$used_pct" ]] || continue
  # 85% is where Odoo's filestore growth and Postgres WAL start to matter on
  # this host; a fuller disk is a failure, not a warning.
  if (( used_pct >= 92 )); then
    fail "$mount at ${used_pct}% (Odoo and Postgres both write here)"
  elif (( used_pct >= 85 )); then
    warn "$mount at ${used_pct}%"
  else
    ok "$mount at ${used_pct}%"
  fi
done

echo
echo "Certificate renewal"
if systemctl list-timers certbot.timer --no-pager >/dev/null 2>&1 \
   && systemctl is-enabled certbot.timer >/dev/null 2>&1; then
  next="$(systemctl list-timers certbot.timer --no-pager 2>/dev/null | sed -n '2p' | awk '{print $1, $2, $3}')"
  ok "certbot.timer enabled (next: ${next:-unknown})"
else
  warn "certbot.timer is not installed/enabled - issue it as root if PROJECT_HTTPS_ENABLED is used"
fi

echo
echo "Log volume"
for dir in /var/log/cartenz /var/log/nginx; do
  [[ -d "$dir" ]] || continue
  size="$(du -sh "$dir" 2>/dev/null | cut -f1)"
  ok "$dir: ${size:-unknown}"
done

echo
if (( FAIL > 0 )); then
  echo "RESULT: $FAIL failure(s), $WARN warning(s)"
  exit 1
fi
echo "RESULT: all checks passed, $WARN warning(s)"
exit 0
