#!/usr/bin/env bash
# shellcheck shell=bash
#
# .env file handling for the installer (ADR-048).
#
# One copy of the upsert logic that three installers used to re-implement:
# reads the existing file, drops any line for the key, appends the new value,
# and installs the result atomically with the right owner and mode. Never
# duplicates a key, never touches an unrelated line.
#
# Cartenz's own .env and Hermes' .env have different owners and modes, which is
# why those are parameters rather than hardcoded defaults.

# Replaces or adds KEY=VALUE in $ENV_FILE (owner $ENV_OWNER, mode $ENV_MODE).
# A file that does not exist is created.
upsert_env() {
  local file="$1" owner="$2" mode="$3" key="$4" value="$5"
  local tmp
  tmp="$(mktemp)"
  grep -vE "^${key}=" "$file" > "$tmp" 2>/dev/null || true
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  install -m "$mode" -o "$owner" -g "$owner" "$tmp" "$file"
  rm -f "$tmp"
}

# True when KEY already carries a non-empty value in $ENV_FILE.
env_key_set() {
  grep -qE "^$1=.+" "$2" 2>/dev/null
}

# Prints the value of KEY from FILE, empty when absent. A value containing '='
# survives because the cut is anchored at the first separator.
env_get() {
  grep -E "^$1=" "$2" 2>/dev/null | head -n 1 | cut -d= -f2- || true
}
