# Adds the three Odoo.sh environments to the existing "Omnisurge" project.
#
# Done through the HTTP API, not SQL, so this exercises the same path the portal
# uses. Needs the owner's password, which is why it is a script the user runs.
A=http://127.0.0.1:4000/api/v1
EMAIL="${EMAIL:?set EMAIL}"
PASSWORD="${PASSWORD:?set PASSWORD}"
PROJECT_ID="${PROJECT_ID:-8d52c2a8-c645-415c-b6df-33dead211281}"

jf() { node -e '
  let raw=""; process.stdin.on("data",c=>raw+=c);
  process.stdin.on("end",()=>{try{const d=JSON.parse(raw);let v=d;
    for(const k of process.argv[1].split(".")) v=v?.[k];
    process.stdout.write(v==null?"":(typeof v==="object"?JSON.stringify(v):String(v)));}catch{process.stdout.write("")}});
' "$1"; }

T=$(curl -sS -X POST $A/auth/login -H 'Content-Type: application/json' \
  -d "$(node -e 'process.stdout.write(JSON.stringify({email:process.argv[1],password:process.argv[2]}))' "$EMAIL" "$PASSWORD")" | jf accessToken)
[ -n "$T" ] || { echo "could not sign in as $EMAIL"; exit 1; }
AUTH="Authorization: Bearer $T"; J='Content-Type: application/json'

add() {
  R=$(curl -sS -X POST "$A/projects/$PROJECT_ID/environments" -H "$J" -H "$AUTH" \
    -d "{\"name\":\"$1\",\"branch\":\"$2\",\"kind\":\"$3\"}")
  ID=$(printf '%s' "$R" | jf id)
  if [ -n "$ID" ]; then echo "  added   $1 -> $2 ($3)"; echo "$ID"; else echo "  skipped $1: $(printf '%s' "$R" | jf message)"; fi
}

echo "Adding environments to project $PROJECT_ID"
add production main production >/dev/null
STAGING=$(add StagingDM StagingDM staging | tail -1)
add Development Development development >/dev/null

if [ -n "$STAGING" ]; then
  curl -sS -X PATCH "$A/projects/$PROJECT_ID/environments/$STAGING/default" -H "$AUTH" >/dev/null
fi

echo
echo "Environments now:"
curl -sS "$A/projects/$PROJECT_ID/environments" -H "$AUTH" | node -e '
  let r=""; process.stdin.on("data",c=>r+=c).on("end",()=>{
    for (const e of JSON.parse(r))
      console.log("  " + e.name.padEnd(14) + e.branch.padEnd(16) + e.kind +
        (e.isDefaultTarget ? "  <- default target" : ""));
  });'
