#!/usr/bin/env bash
# End-to-end smoke test for the Phase 3 AI development agent (ADR-020).
#
# Verifies that the model layer is wired correctly, that every model call is
# recorded, and - most importantly - that the AI data boundary actually engages on
# real repository content rather than merely existing.
#
# Runs against the scripted provider by default, which is what a deployment with
# no AI_API_KEY uses. That exercises the whole path except the model's judgement.
set -uo pipefail

API="${API:-http://127.0.0.1:4000/api/v1}"
FIXTURE_PATH="${FIXTURE_PATH:-$HOME/.cache/linkederp-fixtures/omnisurge-odoo-secrets.git}"
PGPASSWORD="${PGPASSWORD:-linkederp_dev}"
export PGPASSWORD
STAMP="$(date +%s)-$$"
EMAIL="agent-smoke-${STAMP}@linkederp.test"
PASSWORD="agent-smoke-password-${STAMP}"

PASS=0
FAIL=0
TOKEN=""

check() {
  if [ "$2" = "$3" ]; then echo "  PASS  $1"; PASS=$((PASS + 1));
  else echo "  FAIL  $1 (expected '$3', got '$2')"; FAIL=$((FAIL + 1)); fi
}
check_not() {
  if [ "$2" != "$3" ]; then echo "  PASS  $1"; PASS=$((PASS + 1));
  else echo "  FAIL  $1 (value must not be '$3')"; FAIL=$((FAIL + 1)); fi
}
check_contains() {
  case "$2" in *"$3"*) echo "  PASS  $1"; PASS=$((PASS + 1));;
  *) echo "  FAIL  $1 (expected to contain '$3')"; FAIL=$((FAIL + 1));; esac
}
check_gt() {
  if [ "${2:-0}" -gt "$3" ] 2>/dev/null; then echo "  PASS  $1"; PASS=$((PASS + 1));
  else echo "  FAIL  $1 (expected more than $3, got '${2:-}')"; FAIL=$((FAIL + 1)); fi
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

sql() { psql -h 127.0.0.1 -U linkederp -d linkederp_ai -tAc "$1" 2>/dev/null | tr -d ' '; }
post() { curl -sS -X POST "$API$1" -H 'Content-Type: application/json' ${TOKEN:+-H "Authorization: Bearer $TOKEN"} -d "$2"; }
get() { curl -sS "$API$1" ${TOKEN:+-H "Authorization: Bearer $TOKEN"}; }

echo "LinkedERP AI - AI development agent smoke test (Phase 3)"
echo "API: $API"
echo
echo "0. Fixture with a planted credential"
if [ ! -d "$FIXTURE_PATH" ]; then
  ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  # The --with-secret variant, which plants a credential and a personal email in
  # the model file so that the boundary and the write guard can be verified.
  "$ROOT/infrastructure/scripts/create-test-repository.sh" --with-secret "$FIXTURE_PATH" >/dev/null 2>&1
fi
check "the fixture exists" "$([ -d "$FIXTURE_PATH" ] && echo yes || echo no)" "yes"

echo
echo "1. Account and project"
REGISTER=$(post /auth/register "{
  \"email\": \"$EMAIL\", \"password\": \"$PASSWORD\",
  \"name\": \"Agent Smoke\", \"organizationName\": \"Agent Smoke $STAMP\"
}")
TOKEN=$(printf '%s' "$REGISTER" | jf accessToken)
ORG_ID=$(get /users/me | jf organizations.0.organizationId)

PROJECT=$(post /projects "{
  \"organizationId\": \"$ORG_ID\", \"name\": \"Agent Smoke Project $STAMP\",
  \"projectType\": \"repository\", \"odooVersion\": \"18.0\",
  \"defaultBranch\": \"main\", \"repositoryUrl\": \"file://$FIXTURE_PATH\"
}")
PROJECT_ID=$(printf '%s' "$PROJECT" | jf id)
check_not "the project was created" "$PROJECT_ID" ""

echo
echo "2. The model layer produces the plan"
TASK=$(post "/projects/$PROJECT_ID/tasks" \
  '{"prompt": "Add a customer reference field to Sales Order and show it on the form view."}')
TASK_ID=$(printf '%s' "$TASK" | jf id)

wait_for() {
  local target="$1" current=''
  for _ in $(seq 1 90); do
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

if wait_for waiting_approval; then
  echo "  PASS  the task reached the plan approval gate"
  PASS=$((PASS + 1))
else
  echo "  FAIL  the task did not reach the plan approval gate"
  FAIL=$((FAIL + 1))
fi

DETAIL=$(get "/tasks/$TASK_ID")
PLAN_BY=$(printf '%s' "$DETAIL" | jf plan.generatedBy)
check_not "the plan records what produced it" "$PLAN_BY" ""
check_contains "the plan names the model or says none was called" "$PLAN_BY" "provider"
check_contains "the plan cites a real file" \
  "$(printf '%s' "$DETAIL" | jf plan.filesToModify.0.path)" "omnisurge_sale/"
check "the Odoo version came from the repository" \
  "$(printf '%s' "$DETAIL" | jf plan.odooVersion)" "18.0"

echo
echo "3. The planning call was recorded"
CALLS=$(sql "select count(*) from agent_model_calls where task_id = '$TASK_ID' and operation = 'planning';")
check "one planning call is recorded" "$CALLS" "1"
check_not "the provider is recorded" \
  "$(sql "select provider_id from agent_model_calls where task_id = '$TASK_ID' limit 1;")" ""
check_not "the token usage is recorded" \
  "$(sql "select input_tokens from agent_model_calls where task_id = '$TASK_ID' and operation='planning';")" ""

echo
echo "4. The AI data boundary engaged on real repository content"
# The fixture plants a GitHub token and a personal email address in
# omnisurge_sale/models/sale_order.py, which the analysis reads as an excerpt.
REDACTIONS=$(sql "select redaction_count from agent_model_calls where task_id = '$TASK_ID' and operation = 'planning';")
check_gt "the boundary redacted material before it left the platform" "$REDACTIONS" 0
check "no call was refused outright for this repository" \
  "$(sql "select count(*) from agent_model_calls where task_id = '$TASK_ID' and boundary_refused;")" "0"

FINDINGS=$(sql "select boundary_findings::text from agent_model_calls where task_id = '$TASK_ID' and operation = 'planning';")
check_contains "the finding names the rule that matched" "$FINDINGS" "github_token"
if printf '%s' "$FINDINGS" | grep -q "ghp_fixtureplanted"; then
  echo "  FAIL  the finding must not carry the material that matched"
  FAIL=$((FAIL + 1))
else
  echo "  PASS  the finding does not carry the material that matched"
  PASS=$((PASS + 1))
fi

echo
echo "5. The implementation loop runs through the tool layer"
# Where the loop stops depends on the server (ADR-021 s1): with pushing disabled
# there is no push to approve, so the task completes here. Either way the point
# of this section is that the loop ran, which the checks below establish.
PUSH_ENABLED=$(get /agent/capabilities | jf git.pushEnabled)
post "/tasks/$TASK_ID/approve" '{"decision":"approved"}' >/dev/null
if [ "$PUSH_ENABLED" = "true" ]; then
  if wait_for waiting_approval; then
    echo "  PASS  the task reached the push approval gate"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  the task did not reach the push approval gate"
    FAIL=$((FAIL + 1))
  fi
else
  if wait_for completed; then
    echo "  PASS  the task completed without a push gate (pushing is disabled)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  the task did not complete"
    FAIL=$((FAIL + 1))
  fi
fi

check "one implementation call is recorded" \
  "$(sql "select count(*) from agent_model_calls where task_id = '$TASK_ID' and operation = 'implementation';")" "1"
check_gt "the loop made tool calls" \
  "$(sql "select tool_calls from agent_model_calls where task_id = '$TASK_ID' and operation = 'implementation';")" 0
check_gt "the loop took steps" \
  "$(sql "select steps from agent_model_calls where task_id = '$TASK_ID' and operation = 'implementation';")" 0

DETAIL=$(get "/tasks/$TASK_ID")
check_gt "files were changed" "$(printf '%s' "$DETAIL" | jf diffStats.filesChanged)" 0

echo
echo "6. A redacted credential is never written back to the repository"
# The hazard this closes: the boundary removes a credential before the agent reads
# the file, and a whole-file rewrite would write the redaction back, deleting the
# customer's real credential.
DIFF=$(get "/tasks/$TASK_ID/diff")
PATCH=$(printf '%s' "$DIFF" | jf patch)

if printf '%s' "$PATCH" | grep -q "redacted by the LinkedERP AI data boundary"; then
  echo "  FAIL  a redaction marker was written into the repository"
  FAIL=$((FAIL + 1))
else
  echo "  PASS  no redaction marker was written into the repository"
  PASS=$((PASS + 1))
fi

if printf '%s' "$PATCH" | grep -q '^-COURIER_API_KEY'; then
  echo "  FAIL  the planted credential was deleted from the repository"
  FAIL=$((FAIL + 1))
else
  echo "  PASS  the planted credential survived untouched"
  PASS=$((PASS + 1))
fi

echo
echo "7. The refused write is visible in the action log"
DENIALS=$(sql "select count(*) from agent_actions where task_id = '$TASK_ID' and status = 'failed' and tool_name in ('update_file','create_file');")
check_gt "the refused write was recorded" "$DENIALS" 0

echo
echo "8. The task completes"
post "/tasks/$TASK_ID/approve" '{"decision":"approved"}' >/dev/null
if wait_for completed; then
  echo "  PASS  the task completed"
  PASS=$((PASS + 1))
else
  echo "  FAIL  the task did not complete"
  FAIL=$((FAIL + 1))
fi

COMMIT=$(get "/tasks/$TASK_ID" | jf commitHash)
check "a real commit id was recorded" "${#COMMIT}" "40"

echo
echo "9. The model surface excludes what the workflow drives itself"
CAPABILITIES=$(get /agent/capabilities)
# git_commit, git_push and the validation tools must not be model-callable: a model
# that could commit could commit before its work had been reviewed.
for tool in git_commit git_push run_linter run_python_test run_odoo_test git_branch; do
  if printf '%s' "$CAPABILITIES" | node -e '
    let raw = ""; process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", () => {
      const tools = JSON.parse(raw).tools || [];
      const found = tools.find((t) => t.name === process.argv[1]);
      process.exit(found && found.availableToModel === true ? 0 : 1);
    });
  ' "$tool"; then
    echo "  FAIL  $tool must not be offered to the model"
    FAIL=$((FAIL + 1))
  else
    echo "  PASS  $tool is not offered to the model"
    PASS=$((PASS + 1))
  fi
done

echo
echo "10. Organisation isolation covers the model call record"
OTHER=$(curl -sS -X POST "$API/auth/register" -H 'Content-Type: application/json' \
  -d "{\"email\":\"agent-outsider-$STAMP@linkederp.test\",\"password\":\"$PASSWORD\",\"name\":\"Outsider\",\"organizationName\":\"Outsider $STAMP\"}")
OTHER_TOKEN=$(printf '%s' "$OTHER" | jf accessToken)
check "another organisation cannot read the task" \
  "$(curl -sS -o /dev/null -w '%{http_code}' "$API/tasks/$TASK_ID" -H "Authorization: Bearer $OTHER_TOKEN")" "404"

echo
echo "---------------------------------------------"
echo "  Passed: $PASS    Failed: $FAIL"
echo "---------------------------------------------"
[ "$FAIL" -eq 0 ]
