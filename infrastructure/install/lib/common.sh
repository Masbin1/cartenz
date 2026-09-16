#!/usr/bin/env bash
# shellcheck shell=bash
#
# Shared output, execution and guard helpers for the installer (ADR-048).
#
# Sourced by install.sh and by every stage. Defines exactly one copy of the
# things that were previously duplicated across three installers: the step
# formatting, the dry-run wrapper, and the "run this as the service user"
# wrapper.
#
# Nothing here changes the system. Every function that could is routed through
# `run`, so DRY_RUN=1 is honoured in one place rather than remembered in each
# stage.

# ── output ────────────────────────────────────────────────────────────────────

step()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info()  { printf '    %s\n' "$*"; }
skip()  { printf '    \033[2m- %s\033[0m\n' "$*"; }
ok()    { printf '    \033[32mok\033[0m %s\n' "$*"; }
warn()  { printf '    \033[33mwarning\033[0m %s\n' "$*"; }
fail()  { printf '\n\033[31mfailed:\033[0m %s\n' "$*" >&2; exit 1; }

heading() {
  printf '\n\033[1m%s\033[0m\n' "$*"
  printf '\033[2m%s\033[0m\n' "────────────────────────────────────────────────────────────────"
}

# ── execution ─────────────────────────────────────────────────────────────────

# Runs a command, or prints it under DRY_RUN. Every system change goes through
# this: a stage that calls a command directly is a bug, because --dry-run would
# then lie about what it does.
run() {
  if [ "${DRY_RUN:-0}" = "1" ]; then
    printf '    \033[2mwould run:\033[0m %s\n' "$*"
  else
    "$@"
  fi
}

# Runs a command as the service user with its own HOME, so tools that write
# under ~ (npm, uv, git config) land in the service account rather than root's.
as_user() {
  if [ "${DRY_RUN:-0}" = "1" ]; then
    printf '    \033[2mwould run (as %s):\033[0m %s\n' "$SERVICE_USER" "$*"
  else
    sudo -H -u "$SERVICE_USER" "$@"
  fi
}

# Same, for a shell one-liner. Kept separate from as_user so the common case
# does not pay for a shell, and so a caller must be explicit when it needs one.
as_user_sh() {
  if [ "${DRY_RUN:-0}" = "1" ]; then
    printf '    \033[2mwould run (as %s):\033[0m %s\n' "$SERVICE_USER" "$1"
  else
    sudo -H -u "$SERVICE_USER" bash -lc "$1"
  fi
}

# ── guards ────────────────────────────────────────────────────────────────────

require_root() {
  [ "$(id -u)" = "0" ] || fail "Run as root: sudo $0"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "${2:-$1 is required but was not found.}"
}

# True when a systemd unit file exists, whatever its state.
unit_exists() {
  systemctl list-unit-files "$1.service" >/dev/null 2>&1
}

# True when a PostgreSQL role exists.
pg_role_exists() {
  su postgres -s /bin/sh -c "psql -tAc \"select 1 from pg_roles where rolname='$1'\"" 2>/dev/null | grep -q 1
}

# True when a PostgreSQL database exists.
pg_database_exists() {
  su postgres -s /bin/sh -c "psql -tAc \"select 1 from pg_database where datname='$1'\"" 2>/dev/null | grep -q 1
}

# ── summary ───────────────────────────────────────────────────────────────────

# Stages append one line each; install.sh prints them together at the end, so
# what happened is readable without scrolling back through apt output.
SUMMARY_LINES=()
summary() { SUMMARY_LINES+=("$*"); }

print_summary() {
  [ ${#SUMMARY_LINES[@]} -eq 0 ] && return 0
  heading "Summary"
  for line in "${SUMMARY_LINES[@]}"; do
    printf '  %s\n' "$line"
  done
}
