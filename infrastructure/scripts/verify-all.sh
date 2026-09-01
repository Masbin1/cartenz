#!/usr/bin/env bash
#
# Runs everything and fails if anything fails.
#
# This exists because an aggregate that swallows exit codes is worse than no
# aggregate: a run of the full suite once reported success while 107 checks were
# failing, because the loop that ran them discarded each result. Every figure this
# project reports comes from a command, so the command has to be honest about
# whether it passed.
#
#   ./infrastructure/scripts/verify-all.sh              everything
#   ./infrastructure/scripts/verify-all.sh --fast       skip the smoke suites
#
# The smoke suites need a running stack. They are skipped, loudly, if the API is
# not answering — skipped is reported as a failure, because a suite that did not
# run has not passed.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
API="${API:-http://127.0.0.1:4000/api/v1}"
FAST=0
[ "${1:-}" = "--fast" ] && FAST=1

PASSED=0
FAILED=0
FAILURES=()

run() {
  local label="$1"; shift
  printf '  %-38s ' "$label"

  local output status
  output=$("$@" 2>&1)
  status=$?

  if [ "$status" -eq 0 ]; then
    echo "ok"
    PASSED=$((PASSED + 1))
  else
    echo "FAILED (exit $status)"
    FAILED=$((FAILED + 1))
    FAILURES+=("$label")
    printf '%s\n' "$output" | tail -12 | sed 's/^/      /'
  fi
}

echo "Static checks"
run "backend typecheck"   bash -c "cd '$ROOT/backend' && npx tsc --noEmit"
run "backend lint"        bash -c "cd '$ROOT/backend' && npx eslint src --ext .ts"
run "frontend typecheck"  bash -c "cd '$ROOT/frontend' && npx tsc --noEmit"
run "frontend lint"       bash -c "cd '$ROOT/frontend' && npx eslint . --ext .ts,.tsx"

echo
echo "Unit tests"
run "jest"                bash -c "cd '$ROOT/backend' && npx jest --ci"

echo
echo "Probes against the compiled build"
run "push refusal"        node "$ROOT/infrastructure/scripts/probe-push-refusal.js"
run "validation refusal"  node "$ROOT/infrastructure/scripts/probe-validation-refusal.js"
run "write containment"   node "$ROOT/infrastructure/scripts/probe-write-containment.js"

echo
echo "Portal surfaces"
for s in verify-portal-safety verify-portal-settings verify-portal-deletion; do
  run "$s" bash "$ROOT/infrastructure/scripts/$s.sh"
done

if [ "$FAST" -eq 1 ]; then
  echo
  echo "Smoke suites skipped (--fast)"
else
  echo
  echo "Smoke suites"
  if curl -sSf --max-time 5 "$API/health/ready" >/dev/null 2>&1; then
    for s in smoke-test smoke-test-repository smoke-test-agent smoke-test-safety smoke-test-deletion; do
      run "$s" bash "$ROOT/infrastructure/scripts/$s.sh"
    done
  else
    # Counted as a failure. A suite that did not run has not passed, and reporting
    # it as "skipped" beside a green total is how a broken build looks healthy.
    echo "  the API is not answering at $API; start the stack first"
    FAILED=$((FAILED + 1))
    FAILURES+=("smoke suites (not run: API down)")
  fi
fi

echo
echo "---------------------------------------------"
printf '  %d ok, %d failed\n' "$PASSED" "$FAILED"
if [ "$FAILED" -gt 0 ]; then
  printf '  failed: %s\n' "$(printf '%s, ' "${FAILURES[@]}" | sed 's/, $//')"
  echo "---------------------------------------------"
  exit 1
fi
echo "---------------------------------------------"
