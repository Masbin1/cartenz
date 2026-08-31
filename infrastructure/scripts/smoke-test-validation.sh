#!/usr/bin/env bash
#
# Real Odoo validation (ADR-027).
#
# Runs a task against a repository on this host and asserts that the change was
# actually installed into a throwaway database and tested — and, just as
# important, that nothing else was touched: no customer database opened, no
# scratch database left behind.
#
# Needs VALIDATION_ENABLED=true, a runtime, and the validation role from
# create-validation-role.sh. It says which of those is missing rather than
# failing obscurely.
set -uo pipefail

API="${API:-http://127.0.0.1:4000/api/v1}"
REPOSITORY="${REPOSITORY:-file:///home/masbintang/linkederp/linkederp/Odoo}"
BRANCH="${BRANCH:-Development}"
ODOO_VERSION="${ODOO_VERSION:-19.0}"
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
check_not() {
  if [ "$2" != "$3" ]; then echo "  PASS  $1"; PASS=$((PASS + 1));
  else echo "  FAIL  $1 (must not be '$3')"; FAIL=$((FAIL + 1)); fi
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

sql() {
  psql -h 127.0.0.1 -U linkederp -d linkederp_ai -tAc "$1" 2>/dev/null \
    | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}
post() { curl -sS -X POST "$API$1" -H 'Content-Type: application/json' ${TOKEN:+-H "Authorization: Bearer $TOKEN"} -d "${2:-{\}}"; }
get() { curl -sS "$API$1" ${TOKEN:+-H "Authorization: Bearer $TOKEN"}; }

echo "LinkedERP AI - real Odoo validation (ADR-027)"
echo

echo "0. Is this deployment configured to validate?"
POSTURE=$(get /health/posture)
check "the platform's credentials are isolated" "$(printf '%s' "$POSTURE" | jf database.isolated)" "true"

ROLE_OK=$(sql "select rolcreatedb and not rolsuper from pg_roles where rolname='linkederp_validation';")
check "the validation role exists, can create databases, and is not a superuser" "$ROLE_OK" "t"

REACHABLE=$(sql "select count(*) from pg_database
  where datallowconn and not datistemplate
    and datname not in ('linkederp_ai','postgres')
    and has_database_privilege('linkederp_validation', datname, 'CONNECT');")
check "it cannot open any customer database" "$REACHABLE" "0"

echo
echo "1. Submitting a task against a repository on this host"
TOKEN=$(post /auth/register "{
  \"email\": \"val-$STAMP@linkederp.test\", \"password\": \"validation-password-$STAMP\",
  \"name\": \"Val\", \"organizationName\": \"Val $STAMP\"
}" | jf accessToken)
ORG=$(get /users/me | jf organizations.0.organizationId)

PROJECT_ID=$(post /projects "{
  \"organizationId\": \"$ORG\", \"name\": \"Validation $STAMP\",
  \"projectType\": \"on_premise\", \"odooVersion\": \"$ODOO_VERSION\",
  \"defaultBranch\": \"$BRANCH\", \"repositoryUrl\": \"$REPOSITORY\",
  \"environments\": [{\"name\": \"$BRANCH\", \"branch\": \"$BRANCH\", \"kind\": \"development\"}]
}" | jf id)
check_not "the project was created" "$PROJECT_ID" ""

TASK_ID=$(post "/projects/$PROJECT_ID/tasks" \
  '{"prompt":"Add a delivery reference field to the Sales Order model and show it on the order form view."}' | jf id)
check_not "the task was created" "$TASK_ID" ""

for _ in $(seq 1 90); do
  STATUS=$(sql "select status from agent_tasks where id='$TASK_ID';")
  [ "$STATUS" = "waiting_approval" ] && break
  case "$STATUS" in failed|cancelled) break;; esac
  sleep 2
done
check "the plan is waiting for approval" "$STATUS" "waiting_approval"

echo
echo "2. Approving it runs the repository's own modules"
# Databases before, so anything left behind is attributable to this run.
BEFORE=$(sql "select count(*) from pg_database where datname like 'linkederp_validation_%';")

post "/tasks/$TASK_ID/approve" '{"decision":"approved"}' >/dev/null

# Installing modules takes minutes on a cold database.
for _ in $(seq 1 240); do
  STATUS=$(sql "select status from agent_tasks where id='$TASK_ID';")
  case "$STATUS" in completed|failed|cancelled) break;; esac
  sleep 5
done
echo "  task reached: $STATUS"

RESULTS=$(sql "select coalesce(test_results::text,'') from agent_tasks where id='$TASK_ID';")
echo "  results: $(printf '%s' "$RESULTS" | head -c 200)"

# The assertion this file exists for. "simulated": false means Odoo actually ran.
check "the results are real, not simulated" "$(printf '%s' "$RESULTS" | jf simulated)" "false"
check_not "at least one test ran" "$(printf '%s' "$RESULTS" | jf passed)" ""

NARRATION=$(sql "select coalesce(string_agg(message, ' | '), '') from agent_task_events
  where task_id='$TASK_ID' and message ilike '%validation%';")
check_contains "the task says which Odoo it ran against" "$NARRATION" "odoo $ODOO_VERSION"

echo
echo "3. Nothing was left behind, and nothing else was touched"
AFTER=$(sql "select count(*) from pg_database where datname like 'linkederp_validation_%';")
check "no scratch database remains" "$AFTER" "$BEFORE"

# The check that matters most on a host with customer data: the run created and
# dropped its own database and opened nothing else.
check "the customer databases are all still there" \
  "$(sql "select count(*) from pg_database where datname in
     ('al3','al3-live','al3-prod-august','omnisurge','linkederp-development');")" "5"

check "the platform still cannot open any of them" \
  "$(sql "select count(*) from pg_database
     where datallowconn and not datistemplate
       and datname not in ('linkederp_ai','postgres')
       and has_database_privilege('linkederp', datname, 'CONNECT');")" "0"

# The generated conf lived beside the clone, never inside it, so it cannot appear
# in the diff a person is asked to approve.
PATCH=$(get "/tasks/$TASK_ID/diff" | jf patch)
case "$PATCH" in
  *odoo.conf*) echo "  FAIL  the generated conf leaked into the diff"; FAIL=$((FAIL + 1));;
  *) echo "  PASS  the generated conf is not in the diff"; PASS=$((PASS + 1));;
esac

echo
if [ "$FAIL" -eq 0 ]; then
  echo "VALIDATION SMOKE TEST PASSED ($PASS checks)"
  exit 0
fi
echo "VALIDATION SMOKE TEST FAILED ($PASS passed, $FAIL failed)"
exit 1
