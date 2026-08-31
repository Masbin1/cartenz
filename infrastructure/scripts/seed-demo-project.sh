#!/usr/bin/env bash
#
# Creates an account and a project you can sign into and click around.
#
# Defaults to the LinkedERP Odoo repository on the StagingDM branch, because that
# is a real Odoo 19 addons repository and testing against a real one is the point.
# Override with REPOSITORY_URL, BRANCH, PRODUCTION_BRANCH and ODOO_VERSION.
#
# The password is generated here and printed once, to this terminal. It is not
# written to a file and not sent anywhere. Set PASSWORD to choose your own.
#
#   ./infrastructure/scripts/seed-demo-project.sh
#   EMAIL=you@linkederp.com ./infrastructure/scripts/seed-demo-project.sh
#
set -uo pipefail

API="${API:-http://127.0.0.1:4000/api/v1}"
PORTAL="${PORTAL:-http://127.0.0.1:3000}"

REPOSITORY_URL="${REPOSITORY_URL:-https://github.com/LinkedERP/Odoo.git}"
BRANCH="${BRANCH:-StagingDM}"
PRODUCTION_BRANCH="${PRODUCTION_BRANCH:-main}"
DEVELOPMENT_BRANCH="${DEVELOPMENT_BRANCH:-Development}"
ODOO_VERSION="${ODOO_VERSION:-19.0}"
PROJECT_NAME="${PROJECT_NAME:-LinkedERP Odoo}"

STAMP="$(date +%Y%m%d-%H%M%S)"
EMAIL="${EMAIL:-demo-${STAMP}@linkederp.test}"
ORGANIZATION="${ORGANIZATION:-LinkedERP Demo ${STAMP}}"

# 24 characters of base64 from the kernel's CSPRNG. Generated rather than fixed
# because a seed script with a hardcoded password becomes the password everyone
# uses, including somewhere it matters.
REUSED_ACCOUNT=0
PASSWORD="${PASSWORD:-$(head -c 18 /dev/urandom | base64 | tr -d '=+/' )Aa1}"

jf() {
  node -e '
    let raw = "";
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", () => {
      try {
        const data = JSON.parse(raw);
        let value = data;
        for (const key of process.argv[1].split(".")) value = value?.[key];
        process.stdout.write(
          value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value),
        );
      } catch { process.stdout.write(""); }
    });
  ' "$1"
}

fail() { echo "  FAILED: $1" >&2; exit 1; }

echo "Seeding a project you can sign into"
echo

curl -sSf "$API/health/ready" >/dev/null 2>&1 || fail "the API is not answering at $API. Start the stack first (./infrastructure/scripts/dev-up.sh)."

REGISTER=$(curl -sS -X POST "$API/auth/register" -H 'Content-Type: application/json' -d "$(
  node -e 'process.stdout.write(JSON.stringify({
    email: process.argv[1], password: process.argv[2],
    name: "LinkedERP", organizationName: process.argv[3],
  }))' "$EMAIL" "$PASSWORD" "$ORGANIZATION"
)")

TOKEN=$(printf '%s' "$REGISTER" | jf accessToken)

# Re-running the script with the same email should add a project, not fail. Signing
# in needs the password that account was created with, so PASSWORD must be given.
if [ -z "$TOKEN" ]; then
  REASON=$(printf '%s' "$REGISTER" | jf message)

  case "$REASON" in
    *already*)
      echo "  An account already exists for $EMAIL — signing in instead."
      LOGIN=$(curl -sS -X POST "$API/auth/login" -H 'Content-Type: application/json' -d "$(
        node -e 'process.stdout.write(JSON.stringify({
          email: process.argv[1], password: process.argv[2],
        }))' "$EMAIL" "$PASSWORD"
      )")
      TOKEN=$(printf '%s' "$LOGIN" | jf accessToken)
      [ -n "$TOKEN" ] || fail "could not sign in as $EMAIL. Set PASSWORD to that account's password, or use a different EMAIL."
      REUSED_ACCOUNT=1
      ;;
    *)
      fail "registration failed: $REASON"
      ;;
  esac
fi

ME=$(curl -sS "$API/users/me" -H "Authorization: Bearer $TOKEN")
ORG=$(printf '%s' "$ME" | jf organizations.0.organizationId)
[ -n "$ORG" ] || fail "could not read the organisation"

# Read back rather than echoed from the variable: on reuse the organisation is the
# one that already existed, and naming the other would be a lie in the output.
ORGANIZATION=$(printf '%s' "$ME" | jf organizations.0.organizationName)

PROJECT=$(curl -sS -X POST "$API/projects" -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" -d "$(
  node -e 'process.stdout.write(JSON.stringify({
    organizationId: process.argv[1],
    name: process.argv[2],
    description: "Seeded by seed-demo-project.sh",
    projectType: "odoo_sh",
    odooVersion: process.argv[3],
    defaultBranch: process.argv[4],
    repositoryUrl: process.argv[5],
    environments: [
      { name: "production", branch: process.argv[4], kind: "production" },
      { name: process.argv[6], branch: process.argv[6], kind: "staging" },
      { name: process.argv[7], branch: process.argv[7], kind: "development" },
    ],
  }))' "$ORG" "$PROJECT_NAME" "$ODOO_VERSION" "$PRODUCTION_BRANCH" "$REPOSITORY_URL" "$BRANCH" "$DEVELOPMENT_BRANCH"
)")

PROJECT_ID=$(printf '%s' "$PROJECT" | jf id)
[ -n "$PROJECT_ID" ] || fail "project creation failed: $(printf '%s' "$PROJECT" | jf message)"

echo "  Organisation  $ORGANIZATION"
echo "  Project       $PROJECT_NAME ($PROJECT_ID)"
echo "  Repository    $REPOSITORY_URL"
echo "  Environments"
curl -sS "$API/projects/$PROJECT_ID/environments" -H "Authorization: Bearer $TOKEN" | node -e '
  let raw = ""; process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    for (const e of JSON.parse(raw)) {
      const flags = [e.kind, e.isDefaultTarget ? "default target" : null]
        .filter(Boolean).join(", ");
      console.log(`    ${e.name.padEnd(14)} ${e.branch.padEnd(16)} ${flags}`);
    }
  });'

PUSH=$(curl -sS "$API/agent/capabilities" -H "Authorization: Bearer $TOKEN" | jf git.pushEnabled)
MODEL=$(curl -sS "$API/organizations/$ORG/model-provider" -H "Authorization: Bearer $TOKEN" | jf providerId)

echo
echo "  git.pushEnabled   $PUSH"
echo "  AI provider       $MODEL"
echo
echo "-----------------------------------------------------------------------"
echo "  Sign in at $PORTAL/login"
echo
echo "    email     $EMAIL"
if [ "$REUSED_ACCOUNT" = "1" ]; then
  echo "    password  (unchanged — this is an existing account)"
else
  echo "    password  $PASSWORD"
  echo
  echo "  Printed once, to this terminal only. Not written to any file."
fi
echo "-----------------------------------------------------------------------"

if [ "$MODEL" = "mock" ]; then
  echo
  echo "  No AI provider is configured, so plans come from a template and say so."
  echo "  Set one at $PORTAL/settings — the token is entered there and sealed on"
  echo "  arrival, so it is never in a file, a log, or this terminal."
fi

if [ "$PUSH" != "true" ]; then
  echo
  echo "  Pushing is refused at the process layer, so nothing this platform does"
  echo "  can reach $REPOSITORY_URL. Tasks stop at a reviewable diff."
fi
