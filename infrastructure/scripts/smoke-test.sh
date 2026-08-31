#!/usr/bin/env bash
# End-to-end smoke test against a running stack.
#
# Exercises the documented workflow through the HTTP API only: register, create
# an organisation and a project, submit a prompt, approve the plan, approve the
# push, and confirm the task completes with an audit trail. No database access
# and no internal imports, so it verifies the API as a client sees it.
#
# As of Phase 2 the agent performs a real clone (ADR-019), so the lifecycle
# section needs a repository. A local fixture is created on first run and reached
# through a file:// remote, which requires GIT_ALLOW_LOCAL_REMOTES=true.
set -uo pipefail

API="${API:-http://127.0.0.1:4000/api/v1}"
STAMP="$(date +%s)-$$"
EMAIL="smoke-${STAMP}@linkederp.test"
PASSWORD="smoke-password-${STAMP}"

FIXTURE_PATH="${FIXTURE_PATH:-$HOME/.cache/linkederp-fixtures/omnisurge-odoo.git}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

PASS=0
FAIL=0

check() {
  local label="$1" ; local actual="$2" ; local expected="$3"
  if [ "$actual" = "$expected" ]; then
    echo "  PASS  $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $label (expected '$expected', got '$actual')"
    FAIL=$((FAIL + 1))
  fi
}

check_not() {
  local label="$1" ; local actual="$2" ; local forbidden="$3"
  if [ "$actual" != "$forbidden" ]; then
    echo "  PASS  $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $label (value must not be '$forbidden')"
    FAIL=$((FAIL + 1))
  fi
}

# Minimal JSON field reader. node is already a dependency of the repository.
jsonf() {
  node -e '
    let raw = "";
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", () => {
      try {
        const data = JSON.parse(raw);
        const path = process.argv[1].split(".");
        let value = data;
        for (const key of path) value = value?.[key];
        process.stdout.write(value === undefined || value === null ? "" : String(value));
      } catch {
        process.stdout.write("");
      }
    });
  ' "$1"
}

post() { curl -sS -X POST "$API$1" -H 'Content-Type: application/json' ${TOKEN:+-H "Authorization: Bearer $TOKEN"} -d "$2"; }
get()  { curl -sS "$API$1" ${TOKEN:+-H "Authorization: Bearer $TOKEN"}; }
status_of() { curl -sS -o /dev/null -w '%{http_code}' "$@"; }

echo "LinkedERP AI - end-to-end smoke test"
echo "API: $API"
echo
if [ ! -d "$FIXTURE_PATH" ]; then
  "$ROOT/infrastructure/scripts/create-test-repository.sh" "$FIXTURE_PATH" >/dev/null 2>&1
fi

echo "1. Health"
check "liveness returns 200" "$(status_of "$API/health")" "200"
check "readiness returns 200" "$(status_of "$API/health/ready")" "200"

echo
echo "2. Authentication is required by default"
check "GET /projects without a token is 401" \
  "$(status_of "$API/projects?organizationId=00000000-0000-4000-8000-000000000000")" "401"

echo
echo "3. Registration creates a user and an organisation"
TOKEN=""
REGISTER=$(post /auth/register "{
  \"email\": \"$EMAIL\",
  \"password\": \"$PASSWORD\",
  \"name\": \"Smoke Test User\",
  \"organizationName\": \"Smoke Test Org $STAMP\"
}")
TOKEN=$(printf '%s' "$REGISTER" | jsonf accessToken)
REFRESH=$(printf '%s' "$REGISTER" | jsonf refreshToken)
check_not "an access token was issued" "$TOKEN" ""
check_not "a refresh token was issued" "$REFRESH" ""

ME=$(get /users/me)
ORG_ID=$(printf '%s' "$ME" | jsonf organizations.0.organizationId)
ORG_ROLE=$(printf '%s' "$ME" | jsonf organizations.0.role)
check_not "the user has an organisation" "$ORG_ID" ""
check "the registering user is the owner" "$ORG_ROLE" "owner"

echo
echo "4. A short password is rejected"
check "a 6-character password is 400" \
  "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$API/auth/register" \
     -H 'Content-Type: application/json' \
     -d "{\"email\":\"short-$STAMP@linkederp.test\",\"password\":\"short1\",\"name\":\"Short\"}")" "400"

echo
echo "5. Sign-in works and a wrong password does not"
LOGIN=$(post /auth/login "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")
check_not "sign-in returns a token" "$(printf '%s' "$LOGIN" | jsonf accessToken)" ""
check "a wrong password is 401" \
  "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$API/auth/login" \
     -H 'Content-Type: application/json' \
     -d "{\"email\":\"$EMAIL\",\"password\":\"definitely-not-the-password\"}")" "401"

echo
echo "6. Project creation - connect an existing repository"
PROJECT=$(post /projects "{
  \"organizationId\": \"$ORG_ID\",
  \"name\": \"Smoke Repository Project\",
  \"description\": \"Created by the smoke test\",
  \"projectType\": \"repository\",
  \"odooVersion\": \"18.0\",
  \"defaultBranch\": \"main\",
  \"repositoryUrl\": \"file://$FIXTURE_PATH\"
}")
PROJECT_ID=$(printf '%s' "$PROJECT" | jsonf id)
check_not "the project was created" "$PROJECT_ID" ""
check "the project type is repository" "$(printf '%s' "$PROJECT" | jsonf projectType)" "repository"

echo
echo "7. A repository project without a repository URL is rejected"
check "missing repositoryUrl is 400" \
  "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$API/projects" \
     -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" \
     -d "{\"organizationId\":\"$ORG_ID\",\"name\":\"No Repo $STAMP\",\"projectType\":\"repository\"}")" "400"

echo
echo "8. Project creation - create a new project with AI"
AI_PROJECT=$(post /projects/ai "{
  \"organizationId\": \"$ORG_ID\",
  \"name\": \"Equipment Management\",
  \"odooVersion\": \"18.0\",
  \"description\": \"Manage employee equipment\",
  \"requirements\": [
    {\"title\": \"Register equipment against an employee\"},
    {\"title\": \"Record equipment returns\", \"detail\": \"With a condition note\"}
  ]
}")
AI_PROJECT_ID=$(printf '%s' "$AI_PROJECT" | jsonf id)
check_not "the AI project was created" "$AI_PROJECT_ID" ""
check "the specification records the framework" \
  "$(printf '%s' "$AI_PROJECT" | jsonf specification.framework)" "Odoo"
check "the first requirement is identified REQ-001" \
  "$(printf '%s' "$AI_PROJECT" | jsonf specification.requirements.0.id)" "REQ-001"
check "the deployment target is development" \
  "$(printf '%s' "$AI_PROJECT" | jsonf specification.deployment.environment)" "development"

echo
echo "9. Agent permissions default to the data-blind posture"
DETAIL=$(get "/projects/$PROJECT_ID")
check "repository_read is granted" \
  "$(printf '%s' "$DETAIL" | jsonf agentPermissions.repository_read)" "true"
check "database_metadata_read is granted" \
  "$(printf '%s' "$DETAIL" | jsonf agentPermissions.database_metadata_read)" "true"
check "database_record_read is denied" \
  "$(printf '%s' "$DETAIL" | jsonf agentPermissions.database_record_read)" "false"
check "production_deploy is denied" \
  "$(printf '%s' "$DETAIL" | jsonf agentPermissions.production_deploy)" "false"

echo
echo "10. Database export can never be granted"
check "granting database_export is 400" \
  "$(curl -sS -o /dev/null -w '%{http_code}' -X PATCH "$API/projects/$PROJECT_ID/agent-permissions" \
     -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" \
     -d '{"permissions":{"database_export":true}}')" "400"

echo
echo "11. A credential is sealed and never returned"
CONNECTION=$(post "/projects/$PROJECT_ID/connections" '{
  "connectionType": "github",
  "credential": "ghp_smoketestcredentialvalue0000000000",
  "metadata": {"repository": "linkederp/omnisurge-odoo"}
}')
check "the connection reports a held credential" \
  "$(printf '%s' "$CONNECTION" | jsonf hasCredentials)" "true"
if printf '%s' "$CONNECTION" | grep -q "ghp_smoketestcredentialvalue"; then
  echo "  FAIL  the credential must not appear in the response"
  FAIL=$((FAIL + 1))
else
  echo "  PASS  the credential does not appear in the response"
  PASS=$((PASS + 1))
fi
DETAIL=$(get "/projects/$PROJECT_ID")
if printf '%s' "$DETAIL" | grep -q "ghp_smoketestcredentialvalue"; then
  echo "  FAIL  the credential must not appear in the project detail"
  FAIL=$((FAIL + 1))
else
  echo "  PASS  the credential does not appear in the project detail"
  PASS=$((PASS + 1))
fi

echo
echo "12. Submitting a prompt creates a task and returns immediately"
TASK=$(post "/projects/$PROJECT_ID/tasks" \
  '{"prompt": "Add a customer reference field to Sales Order and Invoice."}')
TASK_ID=$(printf '%s' "$TASK" | jsonf id)
TASK_REF=$(printf '%s' "$TASK" | jsonf task_id)
check_not "the task was created" "$TASK_ID" ""
check "the response carries the initial status" "$(printf '%s' "$TASK" | jsonf status)" "created"
echo "  Task $TASK_REF ($TASK_ID)"

wait_for_status() {
  local target="$1" ; local attempts="${2:-60}"
  for _ in $(seq 1 "$attempts"); do
    local current
    current=$(get "/tasks/$TASK_ID" | jsonf status)
    if [ "$current" = "$target" ]; then return 0; fi
    if [ "$current" = "failed" ] && [ "$target" != "failed" ]; then
      echo "  (task failed while waiting for $target)"
      return 1
    fi
    sleep 1
  done
  return 1
}

echo
echo "13. The task reaches waiting_approval on its own"
if wait_for_status waiting_approval 60; then
  echo "  PASS  the task suspended at waiting_approval"
  PASS=$((PASS + 1))
else
  echo "  FAIL  the task did not reach waiting_approval"
  FAIL=$((FAIL + 1))
fi

DETAIL=$(get "/tasks/$TASK_ID")
check "an implementation plan was produced" \
  "$(printf '%s' "$DETAIL" | jsonf pendingApproval.action)" "implementation_plan"
check_not "the plan has a summary" "$(printf '%s' "$DETAIL" | jsonf plan.summary)" ""
check_not "an AI branch was allocated" "$(printf '%s' "$DETAIL" | jsonf branch)" ""
check "the task is not wholly simulated" "$(printf '%s' "$DETAIL" | jsonf simulated)" "false"
check "validation and push are the simulated capabilities"   "$(printf '%s' "$DETAIL" | jsonf simulatedCapabilities)" "push,validation"
check_not "a base commit was recorded from the real clone"   "$(printf '%s' "$DETAIL" | jsonf baseCommit)" ""

echo
# Whether a push gate follows the plan gate is a server configuration
# (ADR-021 s1): with GIT_PUSH_ENABLED=false the platform cannot push, so it
# completes and says so rather than asking a person to approve the impossible.
PUSH_ENABLED=$(get /agent/capabilities | jsonf git.pushEnabled)
echo "  server reports git.pushEnabled=$PUSH_ENABLED"

echo "14. Approving the plan resumes the task"
post "/tasks/$TASK_ID/approve" '{"decision":"approved","note":"Approved by the smoke test"}' >/dev/null

if [ "$PUSH_ENABLED" = "true" ]; then
  if wait_for_status waiting_approval 60; then
    DETAIL=$(get "/tasks/$TASK_ID")
    check "the second approval gate is the push"       "$(printf '%s' "$DETAIL" | jsonf pendingApproval.action)" "git_push"
    check "files were reported as modified"       "$(printf '%s' "$DETAIL" | jsonf modifiedFiles.0.change)" "modified"
    check "validation was recorded as passing"       "$(printf '%s' "$DETAIL" | jsonf testResults.failed)" "0"
  else
    echo "  FAIL  the task did not reach the second approval gate"
    FAIL=$((FAIL + 1))
  fi

  echo
  echo "15. Approving the push completes the task"
  post "/tasks/$TASK_ID/approve" '{"decision":"approved"}' >/dev/null
  if wait_for_status completed 60; then
    echo "  PASS  the task completed"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  the task did not complete (status: $(get "/tasks/$TASK_ID" | jsonf status))"
    FAIL=$((FAIL + 1))
  fi
else
  echo
  echo "15. With pushing disabled the task completes after the plan approval"
  if wait_for_status completed 120; then
    echo "  PASS  the task completed"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  the task did not complete (status: $(get "/tasks/$TASK_ID" | jsonf status))"
    FAIL=$((FAIL + 1))
  fi
  DETAIL=$(get "/tasks/$TASK_ID")
  check "files were reported as modified"     "$(printf '%s' "$DETAIL" | jsonf modifiedFiles.0.change)" "modified"
  check "validation was recorded as passing"     "$(printf '%s' "$DETAIL" | jsonf testResults.failed)" "0"
  check "no push approval is left pending"     "$(printf '%s' "$DETAIL" | jsonf pendingApproval.action)" ""
fi
echo
echo "16. The action log and event stream were written"
ACTION_COUNT=$(get "/tasks/$TASK_ID/actions" | node -e '
  let raw = ""; process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => { try { process.stdout.write(String(JSON.parse(raw).length)); } catch { process.stdout.write("0"); } });
')
EVENT_COUNT=$(get "/tasks/$TASK_ID/events" | node -e '
  let raw = ""; process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => { try { process.stdout.write(String(JSON.parse(raw).length)); } catch { process.stdout.write("0"); } });
')
echo "  $ACTION_COUNT actions, $EVENT_COUNT events"
if [ "$ACTION_COUNT" -gt 15 ]; then
  echo "  PASS  the action log has more than 15 entries"
  PASS=$((PASS + 1))
else
  echo "  FAIL  the action log is too short ($ACTION_COUNT entries)"
  FAIL=$((FAIL + 1))
fi
if [ "$EVENT_COUNT" -gt 15 ]; then
  echo "  PASS  the event stream has more than 15 entries"
  PASS=$((PASS + 1))
else
  echo "  FAIL  the event stream is too short ($EVENT_COUNT entries)"
  FAIL=$((FAIL + 1))
fi

echo
echo "16b. A project with no repository is refused at submission"
check "submitting to an ai_project without a repository is 400"   "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$API/projects/$AI_PROJECT_ID/tasks"      -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN"      -d '{"prompt":"Add a field to the Sales Order model."}')" "400"

echo
echo "17. Task cancellation"
CANCEL_TASK=$(post "/projects/$PROJECT_ID/tasks" \
  '{"prompt": "This task exists so that cancellation can be tested."}')
CANCEL_ID=$(printf '%s' "$CANCEL_TASK" | jsonf id)
sleep 1
CANCELLED=$(post "/tasks/$CANCEL_ID/cancel" '{"reason":"Cancelled by the smoke test"}')
check "the task reports cancelled" "$(printf '%s' "$CANCELLED" | jsonf status)" "cancelled"
check "cancelling twice is 409" \
  "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$API/tasks/$CANCEL_ID/cancel" \
     -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" -d '{}')" "409"

echo
echo "18. Organisation isolation"
OTHER_EMAIL="outsider-${STAMP}@linkederp.test"
OTHER=$(curl -sS -X POST "$API/auth/register" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$OTHER_EMAIL\",\"password\":\"$PASSWORD\",\"name\":\"Outsider\",\"organizationName\":\"Outsider Org $STAMP\"}")
OTHER_TOKEN=$(printf '%s' "$OTHER" | jsonf accessToken)
check "another organisation cannot read the project" \
  "$(curl -sS -o /dev/null -w '%{http_code}' "$API/projects/$PROJECT_ID" \
     -H "Authorization: Bearer $OTHER_TOKEN")" "404"
check "another organisation cannot read the task" \
  "$(curl -sS -o /dev/null -w '%{http_code}' "$API/tasks/$TASK_ID" \
     -H "Authorization: Bearer $OTHER_TOKEN")" "404"

echo
echo "19. The audit trail recorded the run"
AUDIT=$(get "/organizations/$ORG_ID/audit-logs?limit=200")
for event in task.created task.started approval.requested approval.granted task.completed project.created; do
  if printf '%s' "$AUDIT" | grep -q "\"$event\""; then
    echo "  PASS  $event is present"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $event is missing"
    FAIL=$((FAIL + 1))
  fi
done
if printf '%s' "$AUDIT" | grep -q "ghp_smoketestcredentialvalue"; then
  echo "  FAIL  the credential leaked into the audit trail"
  FAIL=$((FAIL + 1))
else
  echo "  PASS  no credential appears in the audit trail"
  PASS=$((PASS + 1))
fi

echo
echo "20. Refresh tokens are single-use"
FIRST=$(post /auth/refresh "{\"refreshToken\":\"$REFRESH\"}")
check_not "the first refresh succeeds" "$(printf '%s' "$FIRST" | jsonf accessToken)" ""
check "reusing the same refresh token is 401" \
  "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$API/auth/refresh" \
     -H 'Content-Type: application/json' -d "{\"refreshToken\":\"$REFRESH\"}")" "401"

echo
echo "---------------------------------------------"
echo "  Passed: $PASS    Failed: $FAIL"
echo "---------------------------------------------"
[ "$FAIL" -eq 0 ]
