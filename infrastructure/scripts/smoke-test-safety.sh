#!/usr/bin/env bash
# Safety smoke test (ADR-021).
#
# Verifies the two guarantees a customer needs before connecting a real
# repository: that the platform cannot push, and that a task cannot target a
# production environment.
#
# Deliberately narrow. It does not test the agent - the other smoke tests do that.
# It tests the guard rails.
set -uo pipefail

API="${API:-http://127.0.0.1:4000/api/v1}"
FIXTURE_PATH="${FIXTURE_PATH:-$HOME/.cache/linkederp-fixtures/omnisurge-odoo.git}"
PGPASSWORD="${PGPASSWORD:-linkederp_dev}"
export PGPASSWORD
STAMP="$(date +%s)-$$"
PASSWORD="safety-password-${STAMP}"

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

jf() {
  node -e '
    let raw = "";
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", () => {
      try {
        const d = JSON.parse(raw); let v = d;
        for (const k of process.argv[1].split(".")) v = v?.[k];
        process.stdout.write(v == null ? "" : (typeof v === "object" ? JSON.stringify(v) : String(v)));
      } catch { process.stdout.write(""); }
    });
  ' "$1"
}

sql() { psql -h 127.0.0.1 -U linkederp -d linkederp_ai -tAc "$1" 2>/dev/null | tr -d ' '; }
post() { curl -sS -X POST "$API$1" -H 'Content-Type: application/json' ${TOKEN:+-H "Authorization: Bearer $TOKEN"} -d "$2"; }
get() { curl -sS "$API$1" ${TOKEN:+-H "Authorization: Bearer $TOKEN"}; }
code() { curl -sS -o /dev/null -w '%{http_code}' "$@"; }

echo "LinkedERP AI - safety smoke test (ADR-021)"
echo

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [ ! -d "$FIXTURE_PATH" ]; then
  "$ROOT/infrastructure/scripts/create-test-repository.sh" "$FIXTURE_PATH" >/dev/null 2>&1
fi

REGISTER=$(post /auth/register "{
  \"email\": \"safety-$STAMP@linkederp.test\", \"password\": \"$PASSWORD\",
  \"name\": \"Safety\", \"organizationName\": \"Safety $STAMP\"
}")
TOKEN=$(printf '%s' "$REGISTER" | jf accessToken)
ORG=$(get /users/me | jf organizations.0.organizationId)

echo "1. Environments are declared with the project"
PROJECT=$(post /projects "{
  \"organizationId\": \"$ORG\", \"name\": \"Safety $STAMP\",
  \"projectType\": \"odoo_sh\", \"odooVersion\": \"17.0\", \"defaultBranch\": \"main\",
  \"repositoryUrl\": \"file://$FIXTURE_PATH\",
  \"environments\": [
    {\"name\": \"production\", \"branch\": \"main\", \"kind\": \"production\"},
    {\"name\": \"staging\", \"branch\": \"staging\", \"kind\": \"staging\"},
    {\"name\": \"dev-1\", \"branch\": \"dev-1\", \"kind\": \"development\"}
  ]
}")
PROJECT_ID=$(printf '%s' "$PROJECT" | jf id)
check_not "project created" "$PROJECT_ID" ""

check "three environments recorded" "$(sql "select count(*) from project_environments where project_id='$PROJECT_ID';")" "3"

# The default target must never be production, even though production was listed first.
DEFAULT_KIND=$(sql "select kind from project_environments where project_id='$PROJECT_ID' and is_default_target=true;")
check "default target is not production" "$DEFAULT_KIND" "staging"

PROD_ID=$(sql "select id from project_environments where project_id='$PROJECT_ID' and kind='production';")
DEV_ID=$(sql "select id from project_environments where project_id='$PROJECT_ID' and kind='development';")

echo

echo
echo "1b. A project with no environments can be repaired, production first"
# A project created before environments existed has none, and could not run a task.
# The repair path had the safety inverted: declaring the production branch was
# refused, while declaring the same branch as development was accepted. That is the
# wrong way round, and every test passed.
BARE=$(post /projects "{
  \"organizationId\": \"$ORG\", \"name\": \"Bare $STAMP\",
  \"projectType\": \"odoo_sh\", \"odooVersion\": \"17.0\", \"defaultBranch\": \"main\",
  \"repositoryUrl\": \"file://$FIXTURE_PATH\"
}")
BARE_ID=$(printf '%s' "$BARE" | jf id)
psql -h 127.0.0.1 -U linkederp -d linkederp_ai -c \
  "delete from project_environments where project_id='$BARE_ID';" >/dev/null 2>&1
check "the project has no environments" \
  "$(sql "select count(*) from project_environments where project_id='$BARE_ID';")" "0"

check_contains "a task says what to do about it" \
  "$(post "/projects/$BARE_ID/tasks" '{"prompt":"Add a field to the Sales Order model."}' | jf message)" \
  "Add one in the project settings"

# Declaring production leaves the project temporarily unusable, and must still be
# allowed: it is the declaration that makes the platform leave that branch alone.
PROD_ADD=$(post "/projects/$BARE_ID/environments" '{"name":"production","branch":"main","kind":"production"}')
check_not "declaring the production branch is accepted" "$(printf '%s' "$PROD_ADD" | jf id)" ""
check_contains "a task then says a targetable environment is needed" \
  "$(post "/projects/$BARE_ID/tasks" '{"prompt":"Add a field to the Sales Order model."}' | jf message)" \
  "Add a staging or development environment"

STAGE_ADD=$(post "/projects/$BARE_ID/environments" '{"name":"dev-1","branch":"dev-1","kind":"development"}')
check_not "declaring a development branch is accepted" "$(printf '%s' "$STAGE_ADD" | jf id)" ""

REPAIRED=$(post "/projects/$BARE_ID/tasks" '{"prompt":"Add a delivery note field to the Sales Order model."}')
check "the task runs, and not on the production branch" \
  "$(sql "select e.branch from agent_tasks t join project_environments e on e.id=t.environment_id
     where t.id='$(printf '%s' "$REPAIRED" | jf id)';")" "dev-1"
echo "2. A task cannot target production"
PROD_TASK=$(post "/projects/$PROJECT_ID/tasks" "{
  \"prompt\": \"Add a field to sale.order. This task must never run.\",
  \"environmentId\": \"$PROD_ID\"
}")
check_contains "production task refused" "$(printf '%s' "$PROD_TASK" | jf message)" "will not run a task against it"
check "no task row was written" "$(sql "select count(*) from agent_tasks where project_id='$PROJECT_ID';")" "0"
check "no session row was written" "$(sql "select count(*) from agent_sessions where project_id='$PROJECT_ID';")" "0"

echo
echo "3. The default target cannot be moved to production"
MOVE=$(curl -sS -X PATCH "$API/projects/$PROJECT_ID/environments/$PROD_ID/default" \
  -H "Authorization: Bearer $TOKEN")
check_contains "moving default to production refused" "$(printf '%s' "$MOVE" | jf message)" "production"
check "default target unchanged" "$(sql "select kind from project_environments where project_id='$PROJECT_ID' and is_default_target=true;")" "staging"

echo
echo "4. A task on a development environment is accepted"
DEV_TASK=$(post "/projects/$PROJECT_ID/tasks" "{
  \"prompt\": \"Add a courier reference field to the Sales Order model.\",
  \"environmentId\": \"$DEV_ID\"
}")
TASK_ID=$(printf '%s' "$DEV_TASK" | jf id)
check_not "development task accepted" "$TASK_ID" ""
check "task records its environment" "$(sql "select environment_id from agent_tasks where id='$TASK_ID';")" "$DEV_ID"

# The environment's branch is the branch that gets cloned. Not the project's
# default branch, which is production here - if that were ever confused, a task
# would read and modify production code while claiming to work on development.
ABSENT=$(post "/projects/$PROJECT_ID/environments"   '{"name": "dev-absent", "branch": "branch-that-does-not-exist", "kind": "development"}')
ABSENT_ID=$(printf '%s' "$ABSENT" | jf id)
ABSENT_TASK=$(post "/projects/$PROJECT_ID/tasks" "{
  \"prompt\": \"This targets a branch the remote does not have.\",
  \"environmentId\": \"$ABSENT_ID\"
}")
ABSENT_TASK_ID=$(printf '%s' "$ABSENT_TASK" | jf id)
for _ in $(seq 1 45); do
  ABSENT_STATE=$(sql "select status from agent_tasks where id='$ABSENT_TASK_ID';")
  case "$ABSENT_STATE" in completed|failed|cancelled|rejected) break;; esac
  sleep 2
done
check "a task on a branch the remote lacks fails" "$ABSENT_STATE" "failed"
check_contains "and says which branch was missing"   "$(sql "select failure_reason from agent_tasks where id='$ABSENT_TASK_ID';")"   "branch-that-does-not-exist"

echo
PUSH_ENABLED=$(get /agent/capabilities | jf git.pushEnabled)
echo "5. Pushing (server reports git.pushEnabled=$PUSH_ENABLED)"

# The plan gate comes first and is genuine: approve it, so that what happens at
# the push gate is what this section is actually measuring.
for _ in $(seq 1 60); do
  [ "$(sql "select status from agent_tasks where id='$TASK_ID';")" = "waiting_approval" ] && break
  sleep 2
done
check "the plan gate was reached" \
  "$(sql "select action from approvals where task_id='$TASK_ID' and status='pending';")" \
  "implementation_plan"
post "/tasks/$TASK_ID/approve" '{"decision":"approved","note":"Approved by the safety smoke test"}' >/dev/null

# waiting_approval is deliberately absent from this terminal set. If the task
# parks at a gate that should not exist, the wait must run out and the check must
# fail - a paused task must not read as a pass.
for _ in $(seq 1 90); do
  STATE=$(sql "select status from agent_tasks where id='$TASK_ID';")
  case "$STATE" in completed|failed|cancelled|rejected) break;; esac
  sleep 2
done

if [ "$PUSH_ENABLED" = "true" ]; then
  # An operator has deliberately enabled pushing. The guarantee is then the
  # approval gate, and it must be there.
  check "a push approval is requested before anything leaves the platform" \
    "$(sql "select action from approvals where task_id='$TASK_ID' and status='pending';")" \
    "git_push"
  check "and the task waits for it rather than pushing" "$STATE" "waiting_approval"
else
  # Pushing is off, which is the default. Then there must be no gate at all: an
  # approval that cannot lead to the act it names teaches people that approvals
  # are decoration.
  check "no push approval was ever requested" \
    "$(sql "select count(*) from approvals where task_id='$TASK_ID' and action='git_push';")" "0"
  check "the task completed without asking to push" "$STATE" "completed"
  check_contains "and says pushing is disabled rather than claiming a push" \
    "$(sql "select message from agent_task_events where task_id='$TASK_ID' and message like '%ushing is disabled%' limit 1;")" \
    "disabled"
fi

# The environment's branch must be what the work is based on. If the project
# default were used instead - production, here - a task would read and change
# production code while reporting that it worked on development.
DEV_TIP=$(git --git-dir="$FIXTURE_PATH" rev-parse dev-1)
check "the work is based on the environment's branch" \
  "$(sql "select base_commit from agent_tasks where id='$TASK_ID';")" "$DEV_TIP"
check_not "the working branch is the agent's own, not the environment's" \
  "$(sql "select branch from agent_tasks where id='$TASK_ID';")" "dev-1"

# The compiled runner, asked to push in every form including the ones that hide
# the subcommand behind git's own options. It is constructed with pushing off, so
# this checks the code whatever this particular server is configured to allow.
PROBE=$(node "$ROOT/infrastructure/scripts/probe-push-refusal.js" 2>&1)
check_contains "with pushing off, the compiled runner refuses every push form" "$PROBE" "PUSH PROBE PASSED"
printf '%s\n' "$PROBE" | grep -E "^  (PASS|FAIL)" | sed 's/^  /    /'

echo
echo "6. Refusals are recorded, not silent"
# Two refusals happened: the production task, and the attempt to move the default.
check "both production refusals are in the audit trail" \
  "$(sql "select count(*) from audit_logs where organization_id='$ORG' and event_type='environment.target_refused';")" "2"
check_contains "the refusal names the branch that was asked for" \
  "$(sql "select metadata::text from audit_logs where organization_id='$ORG' and event_type='environment.target_refused' limit 1;")" \
  "main"

echo
if [ "$FAIL" -eq 0 ]; then
  echo "SAFETY SMOKE TEST PASSED ($PASS checks, git.pushEnabled=$PUSH_ENABLED)"
  exit 0
fi
echo "SAFETY SMOKE TEST FAILED ($PASS passed, $FAIL failed)"
exit 1
