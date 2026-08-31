#!/usr/bin/env bash
#
# Verifies that the archive, restore and permanent-delete surfaces shipped
# (ADR-024), and that the delete asks for the project's name.
#
# Checks the built client chunks rather than a live browser, because these are
# client components and the browser pane here cannot reach the dev server. It
# proves the surfaces shipped, not that a person can click them.
# Run "npx next build" in frontend/ first.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT/frontend"
PASS=0; FAIL=0
has() { if printf '%s' "$2" | grep -qF "$3"; then echo "  PASS  $1"; PASS=$((PASS+1)); else echo "  FAIL  $1"; FAIL=$((FAIL+1)); fi; }

SET=$(cat ".next/static/chunks/app/projects/[projectId]/settings/"*.js 2>/dev/null)
LIST=$(cat .next/static/chunks/app/projects/page-*.js 2>/dev/null)
SHARED=$(cat .next/static/chunks/*.js 2>/dev/null)

echo "Project settings"
has "there is a removal section" "$SET" "Removing this project"
has "archive is offered" "$SET" "Archive project"
has "restore is offered" "$SET" "Restore project"
has "archive says nothing is deleted" "$SET" "Nothing is deleted"
has "permanent delete is offered" "$SET" "Delete this project permanently"
has "it lists what will go" "$SET" "every task and its diffs"
has "it says the repository is untouched" "$SET" "repository itself is untouched"
has "it asks for the name to be typed" "$SET" "to confirm"
has "non-owners are told they cannot" "$SET" "Only an organisation owner"

echo
echo "Project list"
has "archived projects can be shown" "$LIST" "Show archived"
has "archived projects are marked" "$LIST" "archived"
has "a deletion is confirmed after the redirect" "$LIST" "was deleted permanently"
has "and says the repository was not touched" "$LIST" "repository itself was not touched"

echo
echo "API client"
has "the archive endpoint is wired" "$SHARED$SET$LIST" "/restore"
has "the permanent endpoint is wired" "$SHARED$SET$LIST" "/permanent"
has "the list can include archived" "$SHARED$LIST" "includeArchived=true"

echo
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
