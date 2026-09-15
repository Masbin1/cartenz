#!/usr/bin/env bash
#
# Per-project access control (ADR-043).
#
# Every other test of this feature is a unit test of a pure function. This is the
# only one that proves a real second user is actually refused: that the project is
# listed but locked, that opening it is a 403 rather than a 404 or a 200, that a
# request survives the round trip, and that a revoke puts the door back.
#
# Step 4 is the assertion this file exists for. A 200 there means enforcement was
# never reached, and nothing else in the sequence is worth reading.
set -uo pipefail

API="${API:-http://127.0.0.1:4000/api/v1}"
FIXTURE_PATH="${FIXTURE_PATH:-$HOME/.cache/linkederp-fixtures/omnisurge-odoo.git}"
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

# The project's own entry in a list response, by id. Reaching into the array by
# index would test the list's ordering rather than the project's redaction.
pick() {
  node -e '
    let raw = "";
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", () => {
      try {
        const rows = JSON.parse(raw);
        const row = (Array.isArray(rows) ? rows : []).find((r) => r.id === process.argv[1]);
        if (!row) return process.stdout.write("");
        const v = row[process.argv[2]];
        process.stdout.write(v === null ? "null" : v === undefined ? "" : String(v));
      } catch { process.stdout.write(""); }
    });
  ' "$1" "$2"
}

post() { curl -sS -X POST "$API$1" -H 'Content-Type: application/json' ${TOKEN:+-H "Authorization: Bearer $TOKEN"} -d "${2:-{\}}"; }
get() { curl -sS "$API$1" ${TOKEN:+-H "Authorization: Bearer $TOKEN"}; }
code() { curl -sS -o /dev/null -w '%{http_code}' "$@"; }

echo "LinkedERP AI - per-project access control (ADR-043)"
echo

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[ -d "$FIXTURE_PATH" ] || "$ROOT/infrastructure/scripts/create-test-repository.sh" "$FIXTURE_PATH" >/dev/null 2>&1

echo "1. An owner with a project"
TOKEN=$(post /auth/register "{
  \"email\": \"access-owner-$STAMP@linkederp.test\", \"password\": \"access-password-$STAMP\",
  \"name\": \"Access Owner\", \"organizationName\": \"Access $STAMP\"
}" | jf accessToken)
OWNER_TOKEN="$TOKEN"
ORG=$(get /users/me | jf organizations.0.organizationId)
check_not "the owner is in an organisation" "$ORG" ""

NAME="Access probe $STAMP"
PROJECT_ID=$(post /projects "{
  \"organizationId\": \"$ORG\", \"name\": \"$NAME\",
  \"projectType\": \"odoo_sh\", \"odooVersion\": \"17.0\", \"defaultBranch\": \"main\",
  \"repositoryUrl\": \"file://$FIXTURE_PATH\",
  \"environments\": [{\"name\": \"dev-1\", \"branch\": \"dev-1\", \"kind\": \"development\"}]
}" | jf id)
check_not "the project was created" "$PROJECT_ID" ""

echo
echo "2. A second person, added to the organisation as a developer"
PROBE_EMAIL="access-probe-$STAMP@linkederp.test"
PROBE_TOKEN=$(curl -sS -X POST "$API/auth/register" -H 'Content-Type: application/json' -d "{
  \"email\": \"$PROBE_EMAIL\", \"password\": \"probe-password-$STAMP\",
  \"name\": \"Access Probe\", \"organizationName\": \"Probe own $STAMP\"
}" | jf accessToken)
PROBE_USER_ID=$(curl -sS "$API/users/me" -H "Authorization: Bearer $PROBE_TOKEN" | jf id)
check_not "the probe user registered" "$PROBE_USER_ID" ""

ADDED=$(post "/organizations/$ORG/members" "{\"email\": \"$PROBE_EMAIL\", \"role\": \"developer\"}")
check "they are a developer in the owner's organisation" "$(printf '%s' "$ADDED" | jf role)" "developer"

probe_get() { curl -sS "$API$1" -H "Authorization: Bearer $PROBE_TOKEN"; }
probe_code() { code "$@" -H 'Content-Type: application/json' -H "Authorization: Bearer $PROBE_TOKEN"; }

echo
echo "3. The project is listed, and locked"
# Locked, not hidden: a member sees that the project exists and can ask for it.
# That is the whole design decision, and these four assertions are it.
LIST=$(probe_get "/projects?organizationId=$ORG")
check "the project is in their list" "$(printf '%s' "$LIST" | pick "$PROJECT_ID" id)" "$PROJECT_ID"
check "hasAccess is false" "$(printf '%s' "$LIST" | pick "$PROJECT_ID" hasAccess)" "false"
check "repositoryUrl is withheld" "$(printf '%s' "$LIST" | pick "$PROJECT_ID" repositoryUrl)" "null"
check "taskCount is withheld" "$(printf '%s' "$LIST" | pick "$PROJECT_ID" taskCount)" "null"

echo
echo "4. Opening it is refused with 403"
# 403, not 404. The organisation publishes that the project exists; what is
# withheld is access to it. A 404 here would contradict the list above.
check "an ungranted developer gets 403" "$(probe_code "$API/projects/$PROJECT_ID")" "403"

echo
echo "5. They can ask for access"
REQUEST=$(curl -sS -X POST "$API/projects/$PROJECT_ID/access-requests" \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $PROBE_TOKEN" \
  -d '{"reason":"I am picking up the delivery-note work."}')
REQUEST_ID=$(printf '%s' "$REQUEST" | jf id)
check_not "the request was created" "$REQUEST_ID" ""
check "it is pending" "$(printf '%s' "$REQUEST" | jf status)" "pending"

echo
echo "6. Asking twice is refused"
check "a second pending request is a 400" \
  "$(probe_code -X POST "$API/projects/$PROJECT_ID/access-requests" -d '{"reason":"again"}')" "400"

echo
echo "7. The owner sees it waiting"
QUEUE=$(get "/organizations/$ORG/access-requests")
check "the request is listed once" "$(printf '%s' "$QUEUE" | grep -c "$REQUEST_ID")" "1"
check "it names the project" "$(printf '%s' "$QUEUE" | jf 0.projectName)" "$NAME"
check "and who asked" "$(printf '%s' "$QUEUE" | jf 0.userEmail)" "$PROBE_EMAIL"

echo
echo "8. Approving it grants access"
DECIDED=$(curl -sS -X PATCH "$API/projects/$PROJECT_ID/access-requests/$REQUEST_ID" \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $OWNER_TOKEN" \
  -d '{"decision":"approved"}')
check "the decision was recorded" "$(printf '%s' "$DECIDED" | jf decision)" "approved"
check "the queue is empty again" \
  "$(get "/organizations/$ORG/access-requests" | grep -c "$REQUEST_ID")" "0"

echo
echo "9. The grant took effect"
check "the same request now returns 200" "$(probe_code "$API/projects/$PROJECT_ID")" "200"
LIST=$(probe_get "/projects?organizationId=$ORG")
check "the list says hasAccess" "$(printf '%s' "$LIST" | pick "$PROJECT_ID" hasAccess)" "true"
check_not "and the repository is no longer withheld" \
  "$(printf '%s' "$LIST" | pick "$PROJECT_ID" repositoryUrl)" "null"

echo
echo "10. The panel describes where the access came from"
MEMBERS=$(get "/projects/$PROJECT_ID/members")
check "the probe user is in by grant" \
  "$(printf '%s' "$MEMBERS" | node -e '
     let raw=""; process.stdin.on("data",c=>raw+=c); process.stdin.on("end",()=>{
       const m=JSON.parse(raw).find(r=>r.userId===process.argv[1]);
       process.stdout.write(m ? `${m.source}:${m.revocable}` : "");
     });' "$PROBE_USER_ID")" "grant:true"

echo
echo "11. Revoking puts the door back"
check "the revoke is a 204" \
  "$(code -X DELETE "$API/projects/$PROJECT_ID/members/$PROBE_USER_ID" -H "Authorization: Bearer $OWNER_TOKEN")" "204"
check "the project is refused again" "$(probe_code "$API/projects/$PROJECT_ID")" "403"

echo
echo "12. Clean up"
check "the project was deleted" \
  "$(code -X DELETE "$API/projects/$PROJECT_ID/permanent" -H 'Content-Type: application/json' -H "Authorization: Bearer $OWNER_TOKEN" -d "{\"confirmName\":\"$NAME\"}")" "200"

echo
if [ "$FAIL" -eq 0 ]; then
  echo "ACCESS SMOKE TEST PASSED ($PASS checks)"
  exit 0
fi
echo "ACCESS SMOKE TEST FAILED ($PASS passed, $FAIL failed)"
exit 1
