#!/usr/bin/env bash
#
# Archive, restore and permanent deletion (ADR-024).
#
# The point of this test is what a delete leaves behind. A delete that removes the
# project row and leaves a customer's sealed repository credential encrypted in the
# database, owned by nothing, would pass any test that only checked the project was
# gone. So this checks the rows nothing points at any more.
set -uo pipefail

API="${API:-http://127.0.0.1:4000/api/v1}"
FIXTURE_PATH="${FIXTURE_PATH:-$HOME/.cache/linkederp-fixtures/omnisurge-odoo.git}"
PGPASSWORD="${PGPASSWORD:-linkederp_dev}"
export PGPASSWORD
STAMP="$(date +%s)-$$"

PASS=0
FAIL=0
TOKEN=""

check() {
  if [ "$2" = "$3" ]; then echo "  PASS  $1"; PASS=$((PASS + 1));
  else echo "  FAIL  $1 (expected '$3', got '$2')"; FAIL=$((FAIL + 1)); fi
}
check_contains() {
  case "$2" in *"$3"*) echo "  PASS  $1"; PASS=$((PASS + 1));;
  *) echo "  FAIL  $1 (expected to contain '$3')"; FAIL=$((FAIL + 1));; esac
}
check_not() {
  if [ "$2" != "$3" ]; then echo "  PASS  $1"; PASS=$((PASS + 1));
  else echo "  FAIL  $1 (must not be '$3')"; FAIL=$((FAIL + 1)); fi
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

# Trims surrounding whitespace rather than deleting every space: psql pads its
# output, but a value can legitimately contain spaces - a project's name, for one -
# and "tr -d" silently mangles it into something a comparison then fails on.
sql() {
  psql -h 127.0.0.1 -U linkederp -d linkederp_ai -tAc "$1" 2>/dev/null     | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}
post() { curl -sS -X POST "$API$1" -H 'Content-Type: application/json' ${TOKEN:+-H "Authorization: Bearer $TOKEN"} -d "${2:-{\}}"; }
del() { curl -sS -X DELETE "$API$1" -H 'Content-Type: application/json' ${TOKEN:+-H "Authorization: Bearer $TOKEN"} -d "${2:-{\}}"; }
get() { curl -sS "$API$1" ${TOKEN:+-H "Authorization: Bearer $TOKEN"}; }
code() { curl -sS -o /dev/null -w '%{http_code}' "$@"; }

echo "LinkedERP AI - project deletion (ADR-024)"
echo

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[ -d "$FIXTURE_PATH" ] || "$ROOT/infrastructure/scripts/create-test-repository.sh" "$FIXTURE_PATH" >/dev/null 2>&1

TOKEN=$(post /auth/register "{
  \"email\": \"del-$STAMP@linkederp.test\", \"password\": \"deletion-password-$STAMP\",
  \"name\": \"Del\", \"organizationName\": \"Del $STAMP\"
}" | jf accessToken)
ORG=$(get /users/me | jf organizations.0.organizationId)

newProject() {
  post /projects "{
    \"organizationId\": \"$ORG\", \"name\": \"$1\",
    \"projectType\": \"odoo_sh\", \"odooVersion\": \"17.0\", \"defaultBranch\": \"main\",
    \"repositoryUrl\": \"file://$FIXTURE_PATH\",
    \"environments\": [
      {\"name\": \"production\", \"branch\": \"main\", \"kind\": \"production\"},
      {\"name\": \"dev-1\", \"branch\": \"dev-1\", \"kind\": \"development\"}
    ]
  }" | jf id
}

echo "1. Archiving hides a project without destroying anything"
ARCHIVE_ID=$(newProject "Archive me $STAMP")
ARCHIVED=$(del "/projects/$ARCHIVE_ID")
check "the response says it was archived, not deleted" "$(printf '%s' "$ARCHIVED" | jf archived)" "true"
check_contains "and says nothing was deleted" "$(printf '%s' "$ARCHIVED" | jf message)" "Nothing was deleted"
check "the row is still there" "$(sql "select count(*) from projects where id='$ARCHIVE_ID';")" "1"
check_not "archived_at is set" "$(sql "select archived_at from projects where id='$ARCHIVE_ID';")" ""
check "it is gone from the default project list" \
  "$(get "/projects?organizationId=$ORG" | grep -c "$ARCHIVE_ID")" "0"
check "it is still readable directly" "$(code "$API/projects/$ARCHIVE_ID" -H "Authorization: Bearer $TOKEN")" "200"

echo
echo "2. Restoring brings it back"
post "/projects/$ARCHIVE_ID/restore" >/dev/null
check "archived_at is cleared" "$(sql "select coalesce(archived_at::text,'null') from projects where id='$ARCHIVE_ID';")" "null"
check "it is in the project list again" \
  "$(get "/projects?organizationId=$ORG" | grep -c "$ARCHIVE_ID")" "1"

echo

echo
echo "2b. An archived project can be handled, but not worked on"
# The filter that hides archived projects lives in requireProjectAccess, so
# loosening it for read/restore/delete could easily have loosened it for the paths
# that do work. These are the ones that must stay closed.
ARCHIVE2_ID=$(newProject "Archived rules $STAMP")
del "/projects/$ARCHIVE2_ID" >/dev/null
authed() { code "$@" -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN"; }

check "it can still be read" "$(authed "$API/projects/$ARCHIVE2_ID")" "200"
check "it will not accept a task" \
  "$(authed -X POST "$API/projects/$ARCHIVE2_ID/tasks" -d '{"prompt":"Add a field to the Sales Order model."}')" "404"
check "it will not accept a connection" \
  "$(authed -X POST "$API/projects/$ARCHIVE2_ID/connections" -d '{"connectionType":"github","credential":"ghp_shouldnotbeaccepted00000000000000"}')" "404"
check "it will not accept an environment" \
  "$(authed -X POST "$API/projects/$ARCHIVE2_ID/environments" -d '{"name":"dev-2","branch":"dev-2","kind":"development"}')" "404"
check "its agent permissions cannot be changed" \
  "$(authed -X PATCH "$API/projects/$ARCHIVE2_ID/agent-permissions" -d '{"permissions":{"repository_read":true}}')" "404"
check "it can be deleted permanently while archived" \
  "$(authed -X DELETE "$API/projects/$ARCHIVE2_ID/permanent" -d "{\"confirmName\":\"Archived rules $STAMP\"}")" "200"
echo "3. A permanent delete needs the project's name typed back"
NAME="Delete me $STAMP"
DELETE_ID=$(newProject "$NAME")

check "no confirmation at all is a 400" \
  "$(code -X DELETE "$API/projects/$DELETE_ID/permanent" -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" -d '{}')" "400"
check "a wrong name is a 400" \
  "$(code -X DELETE "$API/projects/$DELETE_ID/permanent" -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" -d '{"confirmName":"something else"}')" "400"
check "the wrong case is a 400" \
  "$(code -X DELETE "$API/projects/$DELETE_ID/permanent" -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" -d "{\"confirmName\":\"$(printf '%s' "$NAME" | tr 'A-Z' 'a-z')\"}")" "400"
check_contains "the refusal names the project" \
  "$(del "/projects/$DELETE_ID/permanent" '{"confirmName":"wrong"}' | jf message)" "$NAME"
check "nothing was deleted by any of that" "$(sql "select count(*) from projects where id='$DELETE_ID';")" "1"

echo
echo "4. A running task blocks the delete"
# Sealed here so the delete has a real credential to destroy, and so that step 6
# is checking something that existed.
post "/projects/$DELETE_ID/connections" \
  '{"connectionType":"github","credential":"ghp_deletiontestcredential000000000000","metadata":{"note":"seeded by the deletion smoke test"}}' >/dev/null
SECRET_COUNT=$(sql "select count(*) from secret_records where project_id='$DELETE_ID';")
check "a credential was sealed for this project" "$SECRET_COUNT" "1"

TASK=$(post "/projects/$DELETE_ID/tasks" '{"prompt":"Add a delivery note field to the Sales Order model."}')
TASK_ID=$(printf '%s' "$TASK" | jf id)
check_not "a task was created" "$TASK_ID" ""

BLOCKED=$(del "/projects/$DELETE_ID/permanent" "{\"confirmName\":\"$NAME\"}")
check "the delete is refused with 409 while a task is unfinished" \
  "$(code -X DELETE "$API/projects/$DELETE_ID/permanent" -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" -d "{\"confirmName\":\"$NAME\"}")" "409"
check_contains "the refusal names the task and its status" "$(printf '%s' "$BLOCKED" | jf message)" "$(printf '%s' "$TASK" | jf task_id)"
check_contains "and says what to do about it" "$(printf '%s' "$BLOCKED" | jf message)" "cancel them"
check "the project is still there" "$(sql "select count(*) from projects where id='$DELETE_ID';")" "1"

echo
echo "5. Cancelling the task unblocks it"
CANCELLED=$(post "/tasks/$TASK_ID/cancel" '{"reason":"Cancelled by the deletion smoke test"}')
check "the cancel request was accepted" "$(printf '%s' "$CANCELLED" | jf status)" "cancelled"

# 90 s, not 30. A cancellation is observed by a worker that may be mid-clone, and
# a wait that is merely usually long enough produces a test that usually passes.
for _ in $(seq 1 90); do
  [ "$(sql "select status from agent_tasks where id='$TASK_ID';")" = "cancelled" ] && break
  sleep 1
done
check "the task is cancelled" "$(sql "select status from agent_tasks where id='$TASK_ID';")" "cancelled"

echo
echo "6. The delete removes everything the project owned"
BEFORE_TASKS=$(sql "select count(*) from agent_tasks where project_id='$DELETE_ID';")
BEFORE_ENVS=$(sql "select count(*) from project_environments where project_id='$DELETE_ID';")

RESULT=$(del "/projects/$DELETE_ID/permanent" "{\"confirmName\":\"$NAME\"}")
check "the response reports the deletion" "$(printf '%s' "$RESULT" | jf deleted)" "true"
check "it names what it removed" "$(printf '%s' "$RESULT" | jf projectName)" "$NAME"
check "it reports the secrets it destroyed" "$(printf '%s' "$RESULT" | jf secretsDestroyed)" "1"

check "the project row is gone" "$(sql "select count(*) from projects where id='$DELETE_ID';")" "0"
check "its tasks are gone" "$(sql "select count(*) from agent_tasks where project_id='$DELETE_ID';")" "0"
check_not "there were tasks to remove" "$BEFORE_TASKS" "0"
check "its environments are gone" "$(sql "select count(*) from project_environments where project_id='$DELETE_ID';")" "0"
check_not "there were environments to remove" "$BEFORE_ENVS" "0"
check "its connections are gone" "$(sql "select count(*) from project_connections where project_id='$DELETE_ID';")" "0"
check "its sessions are gone" "$(sql "select count(*) from agent_sessions where project_id='$DELETE_ID';")" "0"
check "its workspace rows are gone" "$(sql "select count(*) from agent_workspaces where project_id='$DELETE_ID';")" "0"

# The check this file exists for. secret_records.project_id carries no foreign
# key, so nothing in the database would have removed these.
check "its sealed secrets are gone, not orphaned" \
  "$(sql "select count(*) from secret_records where project_id='$DELETE_ID';")" "0"

check "the project is a 404 now" "$(code "$API/projects/$DELETE_ID" -H "Authorization: Bearer $TOKEN")" "404"

echo
echo "7. The audit trail outlives the project"
# audit_logs.project_id is ON DELETE SET NULL precisely so this row survives, and
# the name is copied into the metadata so it still means something afterwards.
#
# Scoped to this project's own row rather than counted across the organisation:
# a count is a test of how many other projects the script happens to delete.
DELETED_ROW=$(sql "select metadata::text from audit_logs
  where organization_id='$ORG' and event_type='project.deleted'
  and metadata->>'projectName' = '$NAME' limit 1;")

check_not "project.deleted was recorded for this project" "$DELETED_ROW" ""
check_contains "and it names the project it removed" "$DELETED_ROW" "$NAME"
check_contains "and how many tasks went with it" "$DELETED_ROW" "taskCount"
check "the row survived, with project_id nulled rather than the row removed"   "$(sql "select count(*) from audit_logs
     where organization_id='$ORG' and event_type='project.deleted'
     and metadata->>'projectName' = '$NAME' and project_id is null;")" "1"

check_not "archiving was recorded"   "$(sql "select count(*) from audit_logs where organization_id='$ORG' and event_type='project.archived';")" "0"
check_not "restoring was recorded"   "$(sql "select count(*) from audit_logs where organization_id='$ORG' and event_type='project.restored';")" "0"

echo
echo "8. Only an owner may delete permanently, and only their own project"
OTHER_TOKEN=$(curl -sS -X POST "$API/auth/register" -H 'Content-Type: application/json' -d "{
  \"email\": \"del-other-$STAMP@linkederp.test\", \"password\": \"other-password-$STAMP\",
  \"name\": \"Other\", \"organizationName\": \"Other $STAMP\"
}" | jf accessToken)

SURVIVOR_ID=$(newProject "Survivor $STAMP")
check "another organisation gets 404, not 403" \
  "$(code -X DELETE "$API/projects/$SURVIVOR_ID/permanent" -H 'Content-Type: application/json' -H "Authorization: Bearer $OTHER_TOKEN" -d "{\"confirmName\":\"Survivor $STAMP\"}")" "404"
check "and it is still there" "$(sql "select count(*) from projects where id='$SURVIVOR_ID';")" "1"

echo
echo "9. Archiving is not required first"
# Deleting an active project directly is allowed: requiring an archive step would
# be ceremony, and the typed name is the real safeguard.
del "/projects/$SURVIVOR_ID/permanent" "{\"confirmName\":\"Survivor $STAMP\"}" >/dev/null
check "an unarchived project can be deleted directly" \
  "$(sql "select count(*) from projects where id='$SURVIVOR_ID';")" "0"

echo
echo "10. Deleting twice is a 404, not a 500"
check "the second delete is a 404" \
  "$(code -X DELETE "$API/projects/$SURVIVOR_ID/permanent" -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" -d "{\"confirmName\":\"Survivor $STAMP\"}")" "404"

echo
if [ "$FAIL" -eq 0 ]; then
  echo "DELETION SMOKE TEST PASSED ($PASS checks)"
  exit 0
fi
echo "DELETION SMOKE TEST FAILED ($PASS passed, $FAIL failed)"
exit 1
