#!/usr/bin/env bash
#
# Verifies that the AI provider configuration screen shipped (ADR-023), and that
# it never renders a stored token.
#
# Checks the built client chunks rather than a live browser, because the page is a
# client component and the browser pane here cannot reach the dev server. It
# proves the surface shipped, not that a person can click it.
# Run "npx next build" in frontend/ first.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT/frontend"
PASS=0; FAIL=0
has() { if printf '%s' "$2" | grep -qF "$3"; then echo "  PASS  $1"; PASS=$((PASS+1)); else echo "  FAIL  $1"; FAIL=$((FAIL+1)); fi; }
lacks() { if printf '%s' "$2" | grep -qF "$3"; then echo "  FAIL  $1"; FAIL=$((FAIL+1)); else echo "  PASS  $1"; PASS=$((PASS+1)); fi; }

SET=$(cat .next/static/chunks/app/settings/*.js 2>/dev/null)
SHELL_JS=$(cat .next/static/chunks/*.js 2>/dev/null)

echo "The provider configuration screen"
has "all three providers are offered" "$SET" "OpenAI-compatible endpoint"
has "the no-model option is offered" "$SET" "No model (scripted)"
has "there is an API token field" "$SET" "API token"
has "it says the key cannot be displayed" "$SET" "has no endpoint that returns it"
has "it says a blank field keeps the stored key" "$SET" "keep the stored key"
has "the base URL must be https" "$SET" "Must be https"
has "there is a connection test" "$SET" "Save and test"
# The test saves the form first, so it exercises what is on screen rather than
# what happened to be stored — which is what somebody means by "test this".
has "the model is required for a compatible endpoint" "$SET" "(required)"
has "real endpoints are named, so the URL is not a research task" "$SET" "api.deepseek.com"
has "a local gateway is offered as an option" "$SET" "127.0.0.1:PORT"
has "the configuration can be removed" "$SET" "use the server default"
has "a non-admin is told they cannot change it" "$SET" "Only an owner or admin"
has "it states the model is data-blind" "$SET" "code-aware and data-blind"

echo
echo "The token is never rendered"
has "the field is a password input" "$SET" "password"
lacks "the page never reads a key from the server" "$SET" "settings.apiKey"

echo
echo "Reachable"
has "Settings is in the navigation" "$SHELL_JS" "/settings"

echo
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
