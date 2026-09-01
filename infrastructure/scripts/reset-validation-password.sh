#!/usr/bin/env bash
#
# Resets the validation role's password and writes it straight into .env.
#
#   sudo ./infrastructure/scripts/reset-validation-password.sh
#
# Exists because create-validation-role.sh prints the password once, to the
# terminal, and a password that has to be copied by hand is a password that gets
# lost. This one never displays it: it is generated, set on the role, and written
# to VALIDATION_DB_PASSWORD in .env, which is the only place that needs it.
#
# Safe to run repeatedly. It changes only that role's password and that one line.
set -uo pipefail

ROLE="${ROLE:-linkederp_validation}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$ROOT/.env"

[ -f "$ENV_FILE" ] || { echo "no .env at $ENV_FILE"; exit 1; }

if psql -tAqc 'select 1' >/dev/null 2>&1; then
  run_sql() { psql -tAq; }
elif [ "$(id -u)" = "0" ]; then
  run_sql() { su postgres -s /bin/sh -c 'psql -tAq'; }
else
  echo "This needs a Postgres superuser."
  echo
  echo "  sudo $0"
  echo
  echo "Plain sudo, not 'sudo -u postgres': the postgres user cannot read this file"
  echo "inside a home directory that is mode 0750."
  exit 1
fi

sql() { printf '%s\n' "$1" | run_sql; }

if [ "$(sql "select 1 from pg_roles where rolname = '$ROLE'")" != "1" ]; then
  echo "The role $ROLE does not exist. Run create-validation-role.sh first."
  exit 1
fi

PASSWORD="$(head -c 24 /dev/urandom | base64 | tr -d '=+/')"

sql "ALTER ROLE $ROLE LOGIN CREATEDB NOSUPERUSER NOCREATEROLE PASSWORD '$PASSWORD';" >/dev/null
echo "  password reset on $ROLE"

# Written with python so the value never passes through a shell that might log it,
# and so the rest of .env is left exactly as it was.
PASSWORD="$PASSWORD" ENV_FILE="$ENV_FILE" python3 - <<'PY'
import os, pathlib

path = pathlib.Path(os.environ['ENV_FILE'])
password = os.environ['PASSWORD']
lines = path.read_text().splitlines()

for i, line in enumerate(lines):
    if line.startswith('VALIDATION_DB_PASSWORD='):
        lines[i] = f'VALIDATION_DB_PASSWORD={password}'
        break
else:
    lines.append(f'VALIDATION_DB_PASSWORD={password}')

path.write_text('\n'.join(lines) + '\n')
print('  written to VALIDATION_DB_PASSWORD in .env')
PY

# The file now holds a credential, so it should not be world-readable.
chmod 600 "$ENV_FILE"
OWNER="$(stat -c '%U' "$ROOT")"
chown "$OWNER" "$ENV_FILE" 2>/dev/null || true
echo "  .env is mode 600, owned by $OWNER"

echo
echo "Now restart the API and worker, and validation will run for real."
echo "The password was not displayed. Nothing to copy."
