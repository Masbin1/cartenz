#!/usr/bin/env bash
# End-to-end smoke test for the Phase 2 repository agent (ADR-019).
#
# Separate from smoke-test.sh because it has dependencies that one does not: a
# git repository to clone, and GIT_ALLOW_LOCAL_REMOTES=true so that the local
# fixture is accepted. Keeping them apart means the API contract test stays
# runnable anywhere.
#
# Verifies that the agent really clones, really reads the repository, really
# writes files and really commits - and that the controls which make that safe
# actually refuse what they should.
set -uo pipefail

API="${API:-http://127.0.0.1:4000/api/v1}"
FIXTURE_PATH="${FIXTURE_PATH:-$HOME/.cache/linkederp-fixtures/omnisurge-odoo.git}"
STAMP="$(date +%s)-$$"
EMAIL="repo-smoke-${STAMP}@linkederp.test"
PASSWORD="repo-smoke-password-${STAMP}"

PASS=0
FAIL=0
TOKEN=""

check() {
  local label="$1" actual="$2" expected="$3"
  if [ "$actual" = "$expected" ]; then
    echo "  PASS  $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $label (expected '$expected', got '$actual')"
    FAIL=$((FAIL + 1))
  fi
}

check_not() {
  local label="$1" actual="$2" forbidden="$3"
  if [ "$actual" != "$forbidden" ]; then
    echo "  PASS  $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $label (value must not be '$forbidden')"
    FAIL=$((FAIL + 1))
  fi
}

check_contains() {
  local label="$1" haystack="$2" needle="$3"
  case "$haystack" in
    *"$needle"*)
      echo "  PASS  $label"
      PASS=$((PASS + 1))
      ;;
    *)
      echo "  FAIL  $label (expected to contain '$needle')"
      FAIL=$((FAIL + 1))
      ;;
  esac
}

jf() {
  node -e '
    let raw = "";
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", () => {
      try {
        const data = JSON.parse(raw);
        let value = data;
        for (const key of process.argv[1].split(".")) value = value?.[key];
        process.stdout.write(value === undefined || value === null ? "" : String(value));
      } catch { process.stdout.write(""); }
    });
  ' "$1"
}

post() { curl -sS -X POST "$API$1" -H 'Content-Type: application/json' ${TOKEN:+-H "Authorization: Bearer $TOKEN"} -d "$2"; }
get() { curl -sS "$API$1" ${TOKEN:+-H "Authorization: Bearer $TOKEN"}; }
status_of() { curl -sS -o /dev/null -w '%{http_code}' "$@"; }

echo "LinkedERP AI - repository agent smoke test (Phase 2)"
echo "API: $API"
echo
echo "0. Fixture"
if [ ! -d "$FIXTURE_PATH" ]; then
  ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  "$ROOT/infrastructure/scripts/create-test-repository.sh" "$FIXTURE_PATH" >/dev/null 2>&1
fi
if [ -d "$FIXTURE_PATH" ]; then
  echo "  PASS  the fixture repository exists"
  PASS=$((PASS + 1))
else
  echo "  FAIL  the fixture repository could not be created"
  exit 1
fi

echo
echo "1. Account and organisation"
REGISTER=$(post /auth/register "{
  \"email\": \"$EMAIL\", \"password\": \"$PASSWORD\",
  \"name\": \"Repository Smoke\", \"organizationName\": \"Repo Smoke $STAMP\"
}")
TOKEN=$(printf '%s' "$REGISTER" | jf accessToken)
ORG_ID=$(get /users/me | jf organizations.0.organizationId)
check_not "an organisation was created" "$ORG_ID" ""

echo
echo "2. A hostile repository URL is refused at project creation"
for url in \
  'ext::sh -c id' \
  'http://github.com/a/b.git' \
  'git://github.com/a/b.git' \
  'https://x-access-token:ghp_secret@github.com/a/b.git' \
  '--upload-pack=/bin/sh'
do
  code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$API/projects" \
    -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" \
    -d "{\"organizationId\":\"$ORG_ID\",\"name\":\"Hostile $RANDOM\",\"projectType\":\"repository\",\"repositoryUrl\":\"$url\"}")
  check "refuses $url" "$code" "400"
done

echo
echo "3. Project connected to the fixture"
PROJECT=$(post /projects "{
  \"organizationId\": \"$ORG_ID\", \"name\": \"Omnisurge Odoo $STAMP\",
  \"projectType\": \"repository\", \"odooVersion\": \"18.0\",
  \"defaultBranch\": \"main\", \"repositoryUrl\": \"file://$FIXTURE_PATH\"
}")
PROJECT_ID=$(printf '%s' "$PROJECT" | jf id)
check_not "the project was created" "$PROJECT_ID" ""

echo
echo "4. Submit a prompt"
TASK=$(post "/projects/$PROJECT_ID/tasks" \
  '{"prompt": "Add a customer reference field to Sales Order and show it on the form view."}')
TASK_ID=$(printf '%s' "$TASK" | jf id)
check_not "the task was created" "$TASK_ID" ""
echo "  Task $(printf '%s' "$TASK" | jf task_id)"

wait_for_status() {
  local target="$1" attempts="${2:-90}" current=''
  for _ in $(seq 1 "$attempts"); do
    current=$(get "/tasks/$TASK_ID" | jf status)
    [ "$current" = "$target" ] && return 0
    if [ "$current" = "failed" ] && [ "$target" != "failed" ]; then
      echo "        task failed: $(get "/tasks/$TASK_ID" | jf failureReason)"
      return 1
    fi
    sleep 1
  done
  echo "        timed out waiting for $target (now $current)"
  return 1
}

echo
echo "5. The clone and the analysis are real"
if wait_for_status waiting_approval; then
  echo "  PASS  the task reached the plan approval gate"
  PASS=$((PASS + 1))
else
  echo "  FAIL  the task did not reach the plan approval gate"
  FAIL=$((FAIL + 1))
fi

DETAIL=$(get "/tasks/$TASK_ID")
check_not "a base commit was recorded from the clone" "$(printf '%s' "$DETAIL" | jf baseCommit)" ""
check_contains "the branch follows the ai/ naming scheme" \
  "$(printf '%s' "$DETAIL" | jf branch)" "ai/task_"
check "the task is not wholly simulated" "$(printf '%s' "$DETAIL" | jf simulated)" "false"
check "only validation and push are simulated" \
  "$(printf '%s' "$DETAIL" | jf simulatedCapabilities)" "push,validation"

echo
echo "6. The plan names files that exist in the repository"
check_contains "the plan targets the real model file" \
  "$(printf '%s' "$DETAIL" | jf plan.filesToModify.0.path)" "omnisurge_sale/models/sale_order.py"
check_contains "the plan targets the real view file" \
  "$(printf '%s' "$DETAIL" | jf plan.filesToModify.1.path)" "omnisurge_sale/views/sale_order_views.xml"
check "the Odoo version was detected from the manifests" \
  "$(printf '%s' "$DETAIL" | jf plan.odooVersion)" "18.0"

echo
echo "7. Approving the plan produces a real diff"
# With pushing disabled the task completes here instead of stopping at a push
# gate, and the diff is on the completed task rather than on a paused one.
PUSH_ENABLED=$(get /agent/capabilities | jf git.pushEnabled)
post "/tasks/$TASK_ID/approve" '{"decision":"approved"}' >/dev/null
if [ "$PUSH_ENABLED" = "true" ]; then
  if wait_for_status waiting_approval; then
    echo "  PASS  the task reached the push approval gate"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  the task did not reach the push approval gate"
    FAIL=$((FAIL + 1))
  fi
else
  if wait_for_status completed; then
    echo "  PASS  the task completed without a push gate (pushing is disabled)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  the task did not complete"
    FAIL=$((FAIL + 1))
  fi
fi

DETAIL=$(get "/tasks/$TASK_ID")
check "two files were changed" "$(printf '%s' "$DETAIL" | jf diffStats.filesChanged)" "2"
check_not "lines were added" "$(printf '%s' "$DETAIL" | jf diffStats.linesAdded)" "0"
check "a diff is available for review" "$(printf '%s' "$DETAIL" | jf hasDiff)" "true"

DIFF=$(get "/tasks/$TASK_ID/diff")
PATCH=$(printf '%s' "$DIFF" | jf patch)
check "the diff endpoint reports it is available" "$(printf '%s' "$DIFF" | jf available)" "true"
check_contains "the patch is a real unified diff" "$PATCH" "diff --git"
check_contains "the patch names the real model file" "$PATCH" "omnisurge_sale/models/sale_order.py"
check_contains "the patch shows added lines" "$PATCH" "+# --- LinkedERP AI"

echo
echo "8. The generated XML is well formed"
# Two roots would mean the block was appended after the closing element, which
# Odoo refuses to load. Counted on the patch's added lines.
OPEN_COUNT=$(printf '%s' "$PATCH" | grep -c '^+.*<odoo>' || true)
check "the change does not add a second XML root" "$OPEN_COUNT" "0"
check_contains "the XML block is inside the document" "$PATCH" "LinkedERP AI: begin generated block"

echo
echo "9. The task completes with a real commit"
# Only meaningful where a push gate exists; otherwise the task is already done.
if [ "$PUSH_ENABLED" = "true" ]; then
  post "/tasks/$TASK_ID/approve" '{"decision":"approved"}' >/dev/null
fi
if wait_for_status completed; then
  echo "  PASS  the task completed"
  PASS=$((PASS + 1))
else
  echo "  FAIL  the task did not complete"
  FAIL=$((FAIL + 1))
fi

DETAIL=$(get "/tasks/$TASK_ID")
COMMIT=$(printf '%s' "$DETAIL" | jf commitHash)
# A real object id is 40 hexadecimal characters. The Phase 1 placeholder was
# "simulated-task_NNNN", so a length check distinguishes them.
check "a real 40-character commit id was recorded" "${#COMMIT}" "40"
check_not "the commit is not the old placeholder" \
  "$(printf '%s' "$COMMIT" | cut -c1-9)" "simulated"

echo
echo "10. Project memory records what the repository actually is"
PROJECT_DETAIL=$(get "/projects/$PROJECT_ID")
check "the detected Odoo version is recorded" \
  "$(printf '%s' "$PROJECT_DETAIL" | jf memory.detectedOdooVersion)" "18.0"
check "the Python version was read from the repository" \
  "$(printf '%s' "$PROJECT_DETAIL" | jf memory.pythonVersion)" "3.11"
# jf renders a value with String(), which turns an array of objects into
# "[object Object]", so the technical names are extracted here instead.
MEMORY_MODULES=$(printf '%s' "$PROJECT_DETAIL" | node -e '
  let raw = ""; process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    try {
      const modules = JSON.parse(raw).memory?.modules ?? [];
      process.stdout.write(modules.map((m) => m.technicalName).join(" "));
    } catch { process.stdout.write(""); }
  });')
for module in omnisurge_base omnisurge_sale omnisurge_large; do
  check_contains "the module inventory includes $module" "$MEMORY_MODULES" "$module"
done

echo
echo "10b. A file larger than the audit filter's string limit survives the round trip"
# The regression this exists for (ADR-022): the audit redaction filter truncates
# every string to 2 KB, that filter was applied to the value returned to the agent,
# and so read_file silently returned the first ~55 lines of any larger file. A
# write-back then deleted the rest. Every fixture file was under 2 KB, which is why
# nothing failed until a real 1101-line customer module was cloned.
BIG_TASK=$(post "/projects/$PROJECT_ID/tasks"   '{"prompt": "Add a courier tracking note field to the omnisurge.big model."}')
BIG_ID=$(printf '%s' "$BIG_TASK" | jf id)

wait_for_big() {
  local target="$1" current=''
  for _ in $(seq 1 90); do
    current=$(get "/tasks/$BIG_ID" | jf status)
    [ "$current" = "$target" ] && return 0
    case "$current" in failed|cancelled) echo "        task $current"; return 1;; esac
    sleep 1
  done
  echo "        timed out waiting for $target (now $current)"
  return 1
}

if wait_for_big waiting_approval; then
  post "/tasks/$BIG_ID/approve" '{"decision":"approved"}' >/dev/null
  PUSH_ON=$(get /agent/capabilities | jf git.pushEnabled)
  if [ "$PUSH_ON" = "true" ]; then
    wait_for_big waiting_approval && post "/tasks/$BIG_ID/approve" '{"decision":"approved"}' >/dev/null
  fi
  wait_for_big completed || true
fi

BIG_DETAIL=$(get "/tasks/$BIG_ID")
BIG_PATCH=$(get "/tasks/$BIG_ID/diff" | jf patch)
BIG_REMOVED=$(printf '%s' "$BIG_DETAIL" | jf diffStats.linesRemoved)

echo "  status: $(printf '%s' "$BIG_DETAIL" | jf status), +$(printf '%s' "$BIG_DETAIL" | jf diffStats.linesAdded)/-${BIG_REMOVED}"

# The assertion that would have caught the defect. A change to add a field must
# not delete lines; a handful is tolerated for a rewritten declaration, hundreds
# is the failure.
if [ -n "$BIG_REMOVED" ] && [ "$BIG_REMOVED" -le 20 ]; then
  echo "  PASS  the change deleted no more than 20 lines (${BIG_REMOVED})"
  PASS=$((PASS + 1))
else
  echo "  FAIL  the change deleted ${BIG_REMOVED:-?} lines - a truncated read was written back"
  FAIL=$((FAIL + 1))
fi

# The marker on the file's last line must still be there.
if printf '%s' "$BIG_PATCH" | grep -q '^-.*OMNISURGE_TAIL_MARKER'; then
  echo "  FAIL  the end of the large file was deleted"
  FAIL=$((FAIL + 1))
else
  echo "  PASS  the end of the large file was not deleted"
  PASS=$((PASS + 1))
fi

# And the file must actually have been changed. Without this, the section passes
# when the write is refused and the file is skipped - which is what the
# destructive-rewrite guard does if a truncated read reaches it. The guard
# preventing the damage is right, but it must not be mistaken for the round trip
# working: this line is what distinguishes the two.
if printf '%s' "$BIG_PATCH" | grep -q 'omnisurge_large/models/big_model.py'; then
  echo "  PASS  the large file was actually modified, not skipped"
  PASS=$((PASS + 1))
else
  echo "  FAIL  the large file was not modified - the read was truncated and the write refused"
  FAIL=$((FAIL + 1))
fi


echo
echo "11. Workspaces are released, not left on disk"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LEFTOVER=$(find "$ROOT/.runtime/workspaces" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | wc -l)
check "no workspace directory remains" "$LEFTOVER" "0"

echo
echo "12. A project with no repository is refused at submission"
# The task would otherwise clone nothing, plan anyway, ask a person to approve
# that plan, and only then fail because there is nothing to modify. Refusing at
# submission tells the user the one thing they need to do.
AI_PROJECT=$(post /projects/ai "{
  \"organizationId\": \"$ORG_ID\", \"name\": \"Spec Only $STAMP\",
  \"odooVersion\": \"18.0\", \"description\": \"A project with no repository\",
  \"requirements\": [{\"title\": \"Something\"}]
}")
AI_ID=$(printf '%s' "$AI_PROJECT" | jf id)
check_not "the specification-only project was created" "$AI_ID" ""

AI_ATTEMPT=$(post "/projects/$AI_ID/tasks" '{"prompt": "Add a field to the Sales Order model please."}')
check "submitting a task is refused with 400"   "$(status_of "$API/projects/$AI_ID/tasks" -X POST      -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN"      -d '{"prompt":"Add a field to the Sales Order model please."}')" "400"
check_contains "the refusal explains what to do"   "$(printf '%s' "$AI_ATTEMPT" | jf message)" "no repository connected"

echo "13. Organisation isolation covers the diff endpoint"
OTHER=$(curl -sS -X POST "$API/auth/register" -H 'Content-Type: application/json' \
  -d "{\"email\":\"repo-outsider-$STAMP@linkederp.test\",\"password\":\"$PASSWORD\",\"name\":\"Outsider\",\"organizationName\":\"Outsider $STAMP\"}")
OTHER_TOKEN=$(printf '%s' "$OTHER" | jf accessToken)
check "another organisation cannot read the diff" \
  "$(status_of "$API/tasks/$TASK_ID/diff" -H "Authorization: Bearer $OTHER_TOKEN")" "404"

echo
echo "---------------------------------------------"
echo "  Passed: $PASS    Failed: $FAIL"
echo "---------------------------------------------"
[ "$FAIL" -eq 0 ]
