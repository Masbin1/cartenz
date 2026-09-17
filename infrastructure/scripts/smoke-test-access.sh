#!/usr/bin/env bash
#
# Per-project access control (ADR-043), on the region model (ADR-044).
#
# Every other test of this feature is a unit test of a pure function. This is the
# only one that proves a real second user is actually refused: that the project is
# listed but locked, that opening it is a 403 rather than a 404 or a 200, that a
# request survives the round trip, and that a revoke puts the door back.
#
# Rewritten for ADR-044. The earlier version posted the organisation fields that
# ADR-044 removed (`organizationName` at registration, `organizationId` on
# creation), so it failed at step 1 and its "24 checks" stopped describing this
# API. Two facts of the region model shape this version:
#
#   - registration requires `region`, and a project carries one;
#   - approving a request, granting and revoking are admin actions
#     (`users.is_admin`). The script elevates its own fixture owner with one SQL
#     statement - exactly what the first-account rule does on a fresh deployment
#     - and the JWT guard re-reads `is_admin` from the database on every request,
#     so no re-login is needed after the update. It needs `DATABASE_URL` (read
#     from the repo's .env) for that one statement.
#
# Everything it creates is removed at the end: the project permanently, the
# fixture users from the database.
#
# Step 4 is the assertion this file exists for. A 200 there means enforcement was
# never reached, and nothing else in the sequence is worth reading.
set -uo pipefail

API="${API:-http://127.0.0.1:4000/api/v1}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STAMP="$(date +%s)-$$"

PASS=0
FAIL=0
A_TOKEN=""
B_TOKEN=""
A_ID=""
B_ID=""
PROJECT_ID=""
OWNER_EMAIL="access-owner-$STAMP@linkederp.test"
PROBE_EMAIL="access-probe-$STAMP@linkederp.test"
PASSWORD="access-password-$STAMP"
NAME="Access probe $STAMP"

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

post() { curl -sS -X POST "$API$1" -H 'Content-Type: application/json' ${2:+-H "Authorization: Bearer $2"} -d "$3"; }
get() { curl -sS "$API$1" ${2:+-H "Authorization: Bearer $2"}; }
patch() { curl -sS -X PATCH "$API$1" -H 'Content-Type: application/json' -H "Authorization: Bearer $2" -d "$3"; }
code() { curl -sS -o /dev/null -w '%{http_code}' "$@"; }

cleanup() {
  echo
  echo "cleanup"
  if [ -n "$PROJECT_ID" ] && [ -n "$A_TOKEN" ]; then
    curl -sS -X DELETE "$API/projects/$PROJECT_ID/permanent" \
      -H 'Content-Type: application/json' -H "Authorization: Bearer $A_TOKEN" \
      -d "{\"confirmName\":\"$NAME\"}" >/dev/null 2>&1
    echo "  project deleted permanently"
  fi
  if [ -n "$A_ID" ] || [ -n "$B_ID" ]; then
    set -a; . "$ROOT/.env"; set +a
    psql "$DATABASE_URL" -q -c "delete from users where id in ('$A_ID', '$B_ID')" >/dev/null 2>&1
    echo "  fixture users removed"
  fi
}
trap cleanup EXIT

echo "LinkedERP AI - per-project access control (ADR-043, region model)"
echo

echo "1. Two accounts in region indonesia"
A_TOKEN=$(post /auth/register "" "{\"email\":\"$OWNER_EMAIL\",\"password\":\"$PASSWORD\",\"name\":\"Access Owner\",\"region\":\"indonesia\"}" | jf accessToken)
check_not "the owner registered" "$A_TOKEN" ""
A_ID=$(get /users/me "$A_TOKEN" | jf id)
check_not "the owner has an id" "$A_ID" ""

B_TOKEN=$(post /auth/register "" "{\"email\":\"$PROBE_EMAIL\",\"password\":\"$PASSWORD\",\"name\":\"Access Probe\",\"region\":\"indonesia\"}" | jf accessToken)
check_not "the probe registered" "$B_TOKEN" ""
B_ID=$(get /users/me "$B_TOKEN" | jf id)
check_not "the probe has an id" "$B_ID" ""

# Approval is admin-gated (users.is_admin, ADR-044). Elevate the fixture owner,
# as the first-account rule would have on a fresh deployment.
set -a; . "$ROOT/.env"; set +a
psql "$DATABASE_URL" -q -c "update users set is_admin = true where id = '$A_ID'" >/dev/null 2>&1
check "the owner reads back as admin" "$(get /users/me "$A_TOKEN" | jf isAdmin)" "true"

echo
echo "2. The owner (admin) creates a project"
PROJECT_ID=$(post /projects "$A_TOKEN" "{\"region\":\"indonesia\",\"name\":\"$NAME\",\"projectType\":\"odoo_sh\",\"odooVersion\":\"19.0\",\"repositoryUrl\":\"https://github.com/linkederp/access-probe-fixture.git\"}" | jf id)
check_not "the project was created" "$PROJECT_ID" ""
if [ -z "$PROJECT_ID" ]; then echo "ABORT: no project id"; exit 1; fi

echo
echo "3. The project is listed, and locked"
# Locked, not hidden: a person sees that the project exists and can ask for it.
# That is the whole design decision, and these three assertions are it.
LIST=$(get "/projects" "$B_TOKEN")
check "the project is in their list" "$(printf '%s' "$LIST" | pick "$PROJECT_ID" id)" "$PROJECT_ID"
check "hasAccess is false" "$(printf '%s' "$LIST" | pick "$PROJECT_ID" hasAccess)" "false"
check "repositoryUrl is withheld" "$(printf '%s' "$LIST" | pick "$PROJECT_ID" repositoryUrl)" "null"

echo
echo "4. Opening it is refused with 403"
# 403, not 404. The list publishes that the project exists; what is withheld is
# access to it. A 404 here would contradict the list above.
check "an ungranted user gets 403" "$(code "$API/projects/$PROJECT_ID" -H "Authorization: Bearer $B_TOKEN")" "403"

echo
echo "5. They can ask for access"
REQUEST=$(post "/projects/$PROJECT_ID/access-requests" "$B_TOKEN" '{"reason":"I am picking up the delivery-note work."}')
REQUEST_ID=$(printf '%s' "$REQUEST" | jf id)
check_not "the request was created" "$REQUEST_ID" ""
check "it is pending" "$(printf '%s' "$REQUEST" | jf status)" "pending"

echo
echo "6. Asking twice is refused"
check "a second pending request is a 400" \
  "$(code -X POST "$API/projects/$PROJECT_ID/access-requests" -H 'Content-Type: application/json' -H "Authorization: Bearer $B_TOKEN" -d '{"reason":"again"}')" "400"

echo
echo "7. The admin sees it waiting"
QUEUE=$(get "/access-requests" "$A_TOKEN")
check "the request is listed once" "$(printf '%s' "$QUEUE" | grep -c "$REQUEST_ID")" "1"
check "it names the project" "$(printf '%s' "$QUEUE" | jf 0.projectName)" "$NAME"

echo
echo "8. Approving it grants access"
DECIDED=$(patch "/projects/$PROJECT_ID/access-requests/$REQUEST_ID" "$A_TOKEN" '{"decision":"approved"}')
check "the decision was recorded" "$(printf '%s' "$DECIDED" | jf decision)" "approved"
check "the queue is empty again" "$(get "/access-requests" "$A_TOKEN" | grep -c "$REQUEST_ID")" "0"

echo
echo "9. The grant took effect"
check "the same request now returns 200" "$(code "$API/projects/$PROJECT_ID" -H "Authorization: Bearer $B_TOKEN")" "200"
LIST=$(get "/projects" "$B_TOKEN")
check "the list says hasAccess" "$(printf '%s' "$LIST" | pick "$PROJECT_ID" hasAccess)" "true"
check_not "and the repository is no longer withheld" \
  "$(printf '%s' "$LIST" | pick "$PROJECT_ID" repositoryUrl)" "null"

echo
echo "10. The panel describes where the access came from"
MEMBERS=$(get "/projects/$PROJECT_ID/members" "$A_TOKEN")
check "the probe user is in by grant" \
  "$(printf '%s' "$MEMBERS" | node -e '
     let raw=""; process.stdin.on("data",c=>raw+=c); process.stdin.on("end",()=>{
       const m=JSON.parse(raw).find(r=>r.userId===process.argv[1]);
       process.stdout.write(m ? `${m.source}:${m.revocable}` : "");
     });' "$B_ID")" "grant:true"

echo
echo "11. Revoking puts the door back"
check "the revoke is a 204" \
  "$(code -X DELETE "$API/projects/$PROJECT_ID/members/$B_ID" -H "Authorization: Bearer $A_TOKEN")" "204"
check "the project is refused again" "$(code "$API/projects/$PROJECT_ID" -H "Authorization: Bearer $B_TOKEN")" "403"

echo
if [ "$FAIL" -eq 0 ]; then
  echo "ACCESS SMOKE TEST PASSED ($PASS checks)"
  exit 0
fi
echo "ACCESS SMOKE TEST FAILED ($PASS passed, $FAIL failed)"
exit 1
