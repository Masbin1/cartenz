#!/usr/bin/env bash
set -Eeuo pipefail

# ============================================================
# LinkedERP - tear down every Odoo instance on this host
# ============================================================
#
# Removes the Odoo side of this server and nothing else: the odoo-* systemd
# units, the project directories, the Nginx sites, the certificates for those
# sites, and the project databases. The Cartenz platform, its database
# (linkederp_ai), the Odoo *source* trees and the template databases are NOT
# touched - this script exists to clean projects, not to uninstall Odoo.
#
# Usage:
#   DRY_RUN=1 sudo ./teardown-all-odoo.sh                  # preview only
#   CONFIRM=tear-down-everything sudo ./teardown-all-odoo.sh
#
# It runs as root because every step needs to: pg_dump on a database owned by
# "odoo", systemctl, /etc/nginx, and /opt/odoo/projects (root-owned, so the
# platform user cannot remove anything inside it).
#
# The order is the point. It BACKS UP EVERY DATABASE FIRST and aborts without
# deleting anything if a single dump fails - a teardown that runs out of disk or
# permission half way is how a "clean-up" becomes data loss. The platform's own
# user cannot even read these databases (permission denied for table
# orm_signaling_registry), so this is the only place a backup can be taken.
#
# ============================================================

PROJECTS_DIR="/opt/odoo/projects"
BACKUP_ROOT="/opt/cartenz/.runtime/backups"
NGINX_AVAILABLE="/etc/nginx/sites-available"
NGINX_ENABLED="/etc/nginx/sites-enabled"
SYSTEMD_DIR="/etc/systemd/system"
BASE_DOMAIN="${BASE_DOMAIN:-masbintang.space}"

# Databases to drop.
DATABASES=(
    bankcook ggroma guitartuna omaga omg osza pizzaitalia projectandre
    testing tokoemasabc tokorotibintang tokorotiku vania tpltest
)

# Never dropped, whatever the list above says. linkederp_ai is the platform's
# own; the cartenz_tpl_* pair are the Odoo templates ADR-045 built, and dropping
# them is not a clean-up - it is removing the thing that makes provisioning fast,
# and it costs a full rebuild to get back.
PROTECTED_DATABASES=(
    linkederp_ai postgres template0 template1 cartenz_tpl_19_0_com cartenz_tpl_19_0_ent
)

# Nginx sites to remove, and the two that must survive (the portal and default).
SITES=(
    bankcook dodolbintangmas dodolmasbintang ggroma guitartuna omaga omg osza
    pizzaitalia projectandre testing tokoemasabc tokorotibintang tokorotiku vania
)
PROTECTED_SITES=( cartenz default )

DRY_RUN="${DRY_RUN:-0}"
CONFIRM="${CONFIRM:-}"

log()  { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
info() { printf '   %s\n' "$*"; }
warn() { printf '   !! %s\n' "$*" >&2; }

if [[ "$EUID" -ne 0 ]]; then
    warn "This script must be run as root, in both modes: sudo $0"
    warn "The database probe needs a Postgres connection this user does not have, and a"
    warn "probe that fails must not be mistaken for a database that is absent."
    exit 1
fi

if [[ "$DRY_RUN" != "1" && "$CONFIRM" != "tear-down-everything" ]]; then
    warn "Refusing to run without confirmation."
    warn "Preview with:  DRY_RUN=1 sudo $0"
    warn "Then run with: CONFIRM=tear-down-everything sudo $0"
    exit 1
fi

# ------------------------------------------------------------------
# Is this database present? Three answers, not two.
#
# Returning "absent" when the probe itself failed is the one answer that must
# never be given here: it silently skips the backup of a database that exists and
# is about to be dropped. A failed probe stops the run.
# ------------------------------------------------------------------

db_state() {
    local db="$1" out
    if ! out="$(sudo -u postgres psql -tAc "select 1 from pg_database where datname = '${db}'" 2>&1)"; then
        warn "could not query the cluster for '${db}': ${out}"
        return 2
    fi
    [[ "$out" == "1" ]] && return 0 || return 1
}

# A protected database must never appear in the drop list, however the list is
# edited. Checked before anything runs rather than at the DROP.
for db in "${DATABASES[@]}"; do
    for keep in "${PROTECTED_DATABASES[@]}"; do
        if [[ "$db" == "$keep" ]]; then
            warn "'$db' is protected and also listed for dropping. Refusing to run."
            exit 1
        fi
    done
done

for site in "${PROTECTED_SITES[@]}"; do
    for drop in "${SITES[@]}"; do
        if [[ "$site" == "$drop" ]]; then
            warn "'$site' is protected and also listed for removal. Refusing to run."
            exit 1
        fi
    done
done

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="${BACKUP_ROOT}/pre-teardown-${STAMP}"

if [[ "$DRY_RUN" == "1" ]]; then
    log "DRY RUN - nothing will be changed"
    info "databases to drop : ${DATABASES[*]}"
    info "protected         : ${PROTECTED_DATABASES[*]}"
    info "nginx sites to rm : ${SITES[*]}"
    info "protected sites   : ${PROTECTED_SITES[*]}"
    info "project dirs      : everything directly under ${PROJECTS_DIR}"
    info "units             : every odoo-* unit, enabled or not"
    info "backup dir        : ${BACKUP_DIR}"
fi

# ------------------------------------------------------------------
# 1. Back up every database. Aborts the whole run if any dump fails.
# ------------------------------------------------------------------

log "1/6  Backing up databases to ${BACKUP_DIR}"
if [[ "$DRY_RUN" != "1" ]]; then
    mkdir -p "$BACKUP_DIR"
    for db in "${DATABASES[@]}"; do info "$db"; done | sort > "$BACKUP_DIR/databases.txt"
fi

BACKUP_FAILURES=0
for db in "${DATABASES[@]}"; do
    set +e; db_state "$db"; STATE=$?; set -e

    if [[ "$STATE" -eq 2 ]]; then
        warn "aborting before anything is touched: the database list could not be verified."
        exit 1
    fi
    if [[ "$STATE" -eq 1 ]]; then
        info "skip ${db} (does not exist)"
        continue
    fi

    if [[ "$DRY_RUN" == "1" ]]; then
        info "would dump ${db}"
        continue
    fi

    if sudo -u postgres pg_dump -Fc -d "$db" -f "${BACKUP_DIR}/${db}.dump" 2>"${BACKUP_DIR}/${db}.err"; then
        # A dump is only trusted if it is non-empty AND pg_restore can read its
        # table of contents. A truncated pg_dump exits 0 more often than anyone
        # expects.
        if [[ -s "${BACKUP_DIR}/${db}.dump" ]] \
            && sudo -u postgres pg_restore -l "${BACKUP_DIR}/${db}.dump" >/dev/null 2>&1; then
            info "$(du -h "${BACKUP_DIR}/${db}.dump" | cut -f1)  ${db}"
            rm -f "${BACKUP_DIR}/${db}.err"
        else
            warn "dump for ${db} is empty or unreadable"
            BACKUP_FAILURES=$((BACKUP_FAILURES + 1))
        fi
    else
        warn "pg_dump failed for ${db}: $(head -c 200 "${BACKUP_DIR}/${db}.err")"
        BACKUP_FAILURES=$((BACKUP_FAILURES + 1))
    fi
done

if [[ "$BACKUP_FAILURES" -gt 0 ]]; then
    warn "${BACKUP_FAILURES} database(s) could not be backed up."
    warn "STOPPING HERE. Nothing has been deleted."
    warn "Take those dumps by hand, or remove them from the DATABASES list, then run again."
    exit 1
fi

if [[ "$DRY_RUN" != "1" ]]; then
    ( cd "$BACKUP_DIR" && sha256sum -- *.dump > SHA256SUMS ) 2>/dev/null || true
    info "checksums: ${BACKUP_DIR}/SHA256SUMS"
fi

# ------------------------------------------------------------------
# 2. Stop, disable and remove every odoo-* unit.
# ------------------------------------------------------------------

log "2/6  Stopping and removing odoo-* units"

mapfile -t UNIT_FILES < <(find "$SYSTEMD_DIR" -maxdepth 1 -name 'odoo-*.service' | sort)
mapfile -t ACTIVE_UNITS < <(systemctl list-units --type=service --all --no-legend --plain 'odoo-*' 2>/dev/null \
    | awk '{print $1}' | grep -E '^odoo-.*\.service$' | sort -u)

if [[ ${#UNIT_FILES[@]} -eq 0 && ${#ACTIVE_UNITS[@]} -eq 0 ]]; then
    info "no odoo-* units found"
fi

for unit in "${ACTIVE_UNITS[@]}"; do
    if [[ "$DRY_RUN" == "1" ]]; then
        info "would stop + disable ${unit}"
        continue
    fi
    systemctl disable --now "$unit" >/dev/null 2>&1 && info "stopped + disabled ${unit}" \
        || info "stopped ${unit} (was not enabled, or had no unit file)"
done

for file in "${UNIT_FILES[@]}"; do
    if [[ "$DRY_RUN" == "1" ]]; then
        info "would remove ${file}"
        continue
    fi
    rm -f "$file" && info "removed ${file}"
done

if [[ "$DRY_RUN" != "1" && ${#UNIT_FILES[@]} -gt 0 ]]; then
    systemctl daemon-reload
    info "daemon-reload done"
fi

# ------------------------------------------------------------------
# 3. Drop the databases.
# ------------------------------------------------------------------

log "3/6  Dropping databases"

for db in "${DATABASES[@]}"; do
    set +e; db_state "$db"; STATE=$?; set -e

    if [[ "$STATE" -eq 2 ]]; then
        warn "could not verify '${db}'; skipping the drop rather than guessing."
        continue
    fi
    if [[ "$STATE" -eq 1 ]]; then
        info "skip ${db} (does not exist)"
        continue
    fi

    if [[ "$DRY_RUN" == "1" ]]; then
        info "would drop ${db}"
        continue
    fi

    # An open connection blocks DROP DATABASE. Nothing should be connected once
    # the units are down, but a psql someone left open would otherwise turn this
    # into a partial teardown.
    sudo -u postgres psql -tAc \
        "select pg_terminate_backend(pid) from pg_stat_activity
          where datname = '${db}' and pid <> pg_backend_pid()" >/dev/null 2>&1 || true

    if sudo -u postgres dropdb --if-exists "$db"; then
        info "dropped ${db}"
    else
        warn "could not drop ${db}"
    fi
done

if [[ "$DRY_RUN" != "1" ]]; then
    info "still present: $(sudo -u postgres psql -tAc \
        "select string_agg(datname, ' ' order by datname) from pg_database where not datistemplate" 2>/dev/null)"
fi

# ------------------------------------------------------------------
# 4. Remove the project directories.
# ------------------------------------------------------------------

log "4/6  Removing project directories under ${PROJECTS_DIR}"

if [[ -d "$PROJECTS_DIR" ]]; then
    for entry in "$PROJECTS_DIR"/*; do
        [[ -e "$entry" ]] || continue
        if [[ "$DRY_RUN" == "1" ]]; then
            info "would remove ${entry}"
            continue
        fi
        rm -rf "$entry" && info "removed ${entry}"
    done
    # The projects root itself stays: it is where provisioning creates the next
    # one, and it is root-owned and empty now.
    [[ "$DRY_RUN" == "1" ]] || info "kept ${PROJECTS_DIR} (the root itself)"
else
    info "${PROJECTS_DIR} does not exist"
fi

# ------------------------------------------------------------------
# 5. Remove the Nginx sites.
# ------------------------------------------------------------------

log "5/6  Removing Nginx sites"

NGINX_TOUCHED=0
for site in "${SITES[@]}"; do
    for path in "${NGINX_ENABLED}/${site}" "${NGINX_AVAILABLE}/${site}"; do
        if [[ -e "$path" || -L "$path" ]]; then
            if [[ "$DRY_RUN" == "1" ]]; then
                info "would remove ${path}"
                continue
            fi
            rm -f "$path" && info "removed ${path}"
            NGINX_TOUCHED=1
        fi
    done
done

if [[ "$DRY_RUN" == "1" ]]; then
    info "would run nginx -t and reload"
elif [[ "$NGINX_TOUCHED" -eq 1 ]]; then
    if nginx -t; then
        systemctl reload nginx && info "nginx reloaded"
    else
        warn "nginx -t FAILED - not reloading. The portal may be serving from a broken config."
    fi
else
    info "no site files to remove"
fi

# ------------------------------------------------------------------
# 6. Remove the certificates for those sites.
# ------------------------------------------------------------------

log "6/6  Removing certificates"

for site in "${SITES[@]}"; do
    domain="${site}.${BASE_DOMAIN}"
    if [[ ! -d "/etc/letsencrypt/live/${domain}" ]]; then
        continue
    fi
    if [[ "$DRY_RUN" == "1" ]]; then
        info "would delete certificate ${domain}"
        continue
    fi
    # After the vhost is gone, so certbot has nothing to leave half-referenced.
    if certbot delete --cert-name "$domain" --non-interactive >/dev/null 2>&1; then
        info "deleted certificate ${domain}"
    else
        warn "could not delete certificate ${domain}"
    fi
done

# ------------------------------------------------------------------
# Verdict
# ------------------------------------------------------------------

log "Verdict"

if [[ "$DRY_RUN" == "1" ]]; then
    info "dry run - nothing was changed"
    exit 0
fi

for unit in cartenz-api cartenz-worker cartenz-portal hermes-api 9router; do
    printf '   %-18s %s\n' "$unit" "$(systemctl is-active "$unit" 2>/dev/null || echo unknown)"
done

REMAINING="$(systemctl list-units --type=service --state=running --no-legend --plain 'odoo-*' 2>/dev/null | awk '{print $1}' | tr '\n' ' ')"
if [[ -n "${REMAINING// /}" ]]; then
    warn "still running: ${REMAINING}"
else
    info "no odoo-* service is running"
fi

info "backups: ${BACKUP_DIR}"
