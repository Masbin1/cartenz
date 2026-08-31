#!/usr/bin/env bash
#
# Verifies that the portal actually carries the ADR-021 surfaces: environment
# declaration, target selection, and the push posture read from the server.
#
# Checks the built client chunks rather than a live browser, because the pages are
# client components whose markup is not in the server-rendered HTML, and because
# the browser pane in this environment cannot reach the dev server. It therefore
# proves the strings and endpoints shipped, not that a person can click them.
# Run "npx next build" in frontend/ first.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT/frontend"
PASS=0; FAIL=0
has() { if printf '%s' "$2" | grep -qF "$3"; then echo "  PASS  $1"; PASS=$((PASS+1)); else echo "  FAIL  $1"; FAIL=$((FAIL+1)); fi; }

# The creation form renders only after a flow is chosen, so its markup is in the
# page's client chunk rather than in the server-rendered HTML.
NEW=$(cat .next/static/chunks/app/projects/new/*.js 2>/dev/null)
AGENT=$(cat ".next/static/chunks/app/projects/[projectId]/agent/"*.js 2>/dev/null)
SETTINGS=$(cat ".next/static/chunks/app/projects/[projectId]/settings/"*.js 2>/dev/null)
SHARED=$(cat .next/static/chunks/*.js 2>/dev/null)

echo "Project creation"
has "the environments editor is in the page" "$NEW" "Environments"
has "it explains what an environment is on Odoo.sh" "$NEW" "On Odoo.sh an environment is a branch"
has "it states that production is refused" "$NEW" "one marked production is refused"
has "rows can be added" "$NEW" "Add environment"
has "all three kinds are offered" "$NEW" "Development"
has "it warns when nothing is targetable" "$NEW" "no task could run"

echo
echo "Task submission"
has "the target is labelled" "$AGENT" "Target"
has "it says when this server cannot push" "$AGENT" "This server cannot push"
has "it names the production branch as untargetable" "$AGENT" "cannot be targeted"

echo
echo "Project settings"
has "the environments panel is present" "$SETTINGS" "Environments"
has "the pushing panel is present" "$SETTINGS" "Pushing"
has "the default target can be moved" "$SETTINGS" "Make default"
has "production is marked not targetable" "$SETTINGS" "not targetable"

echo
echo "API client"
has "the environments endpoints are wired" "$SHARED$NEW$AGENT$SETTINGS" "/environments"
has "the default-target endpoint is wired" "$SHARED$NEW$AGENT$SETTINGS" "/default"

echo
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
