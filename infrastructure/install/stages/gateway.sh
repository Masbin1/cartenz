#!/usr/bin/env bash
# shellcheck shell=bash
#
# Stage: gateway — the 9router model gateway.
#
# Installs 9router globally from npm and links it to $GATEWAY_LINK, which is
# what the systemd unit and the .env wiring point at. Skipped when the link
# already exists.

step "gateway: 9router"

if [ -e "$GATEWAY_LINK" ]; then
  skip "$GATEWAY_LINK exists"
else
  if [ "${DRY_RUN:-0}" = "1" ]; then
    run npm install -g 9router
  elif command -v npm >/dev/null 2>&1; then
    npm install -g 9router --silent >/dev/null 2>&1 || warn "9router install failed; install it manually"
    GLOBAL_ROOT="$(npm root -g)"
    if [ -d "$GLOBAL_ROOT/9router" ]; then
      ln -sfn "$GLOBAL_ROOT/9router" "$GATEWAY_LINK"
      ok "linked $GATEWAY_LINK"
    else
      warn "9router not found under $GLOBAL_ROOT — §5 of the install guide"
    fi
  else
    run npm install -g 9router
  fi
fi

summary "gateway: 9router $([ -e "$GATEWAY_LINK" ] && echo linked || echo not-installed)"
