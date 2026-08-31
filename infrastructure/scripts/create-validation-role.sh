#!/usr/bin/env bash
#
# Creates the Postgres role validation runs as, and closes the default that lets
# every role connect to every database (ADR-026, ADR-027).
#
#   sudo ./infrastructure/scripts/create-validation-role.sh
#
# Run it with plain sudo, as root. `sudo -u postgres` does not work here: the
# postgres user cannot traverse a home directory that is mode 0750, which is the
# default on Ubuntu, so it cannot read this file.
#
# What it does, and why:
#
#   1. Creates `linkederp_validation` with LOGIN and CREATEDB and nothing else.
#      Validation must create its own throwaway database and must be able to do
#      nothing else. It must never be the Odoo role, which on a typical
#      on-premise host is a cluster superuser owning every customer database.
#
#   2. Revokes CONNECT on each Odoo database from PUBLIC. A fresh Postgres grants
#      CONNECT to PUBLIC on every database, which is why the platform's own role
#      could open all of them without anyone having granted it anything.
#
#   3. Grants CONNECT back to the Odoo role, so its own server keeps working.
#      Superusers and database owners bypass the check anyway; granting it
#      explicitly means the intent survives a later change that drops the
#      superuser bit.
#
# Nothing here reads or alters a customer's data. Revoking CONNECT changes who may
# open a database, not what is inside it.
set -uo pipefail

ROLE="${ROLE:-linkederp_validation}"
ODOO_ROLE="${ODOO_ROLE:-odoo}"
PLATFORM_ROLE="${PLATFORM_ROLE:-linkederp}"
PLATFORM_DB="${PLATFORM_DB:-linkederp_ai}"

# SQL arrives on stdin rather than as an argument, so nothing here has to be
# quoted through a shell twice - which is where a generated password would break.
if psql -tAqc 'select 1' >/dev/null 2>&1; then
  run_sql() { psql -tAq; }                                   # already the postgres user
elif [ "$(id -u)" = "0" ]; then
  run_sql() { su postgres -s /bin/sh -c 'psql -tAq'; }        # root, via the postgres user
else
  echo "This needs a Postgres superuser."
  echo
  echo "  sudo $0"
  echo
  echo "Use plain sudo, not 'sudo -u postgres': the postgres user cannot read this"
  echo "file inside a home directory that is mode 0750."
  exit 1
fi

sql() { printf '%s\n' "$1" | run_sql; }

echo "Creating the validation role"
PASSWORD="${VALIDATION_PASSWORD:-$(head -c 24 /dev/urandom | base64 | tr -d '=+/')}"

if [ "$(sql "select 1 from pg_roles where rolname = '$ROLE'")" = "1" ]; then
  sql "ALTER ROLE $ROLE LOGIN CREATEDB NOSUPERUSER NOCREATEROLE PASSWORD '$PASSWORD';" >/dev/null
  echo "  $ROLE existed; password and privileges reset"
else
  sql "CREATE ROLE $ROLE LOGIN CREATEDB NOSUPERUSER NOCREATEROLE PASSWORD '$PASSWORD';" >/dev/null
  echo "  $ROLE created"
fi

echo
echo "Closing CONNECT on every database that is not the platform's own"
DATABASES=$(sql "
  select datname from pg_database
  where datallowconn and not datistemplate
    and datname not in ('$PLATFORM_DB', 'postgres')
  order by datname;")

if [ -z "$DATABASES" ]; then
  echo "  none found"
else
  for db in $DATABASES; do
    sql "REVOKE CONNECT ON DATABASE \"$db\" FROM PUBLIC;" >/dev/null
    sql "GRANT CONNECT ON DATABASE \"$db\" TO $ODOO_ROLE;" >/dev/null 2>&1
    echo "  $db"
  done
  echo "  CONNECT revoked from PUBLIC, granted to $ODOO_ROLE"
fi

echo
echo "Verifying"
FAILED=0
for db in $DATABASES; do
  for role in "$PLATFORM_ROLE" "$ROLE"; do
    if [ "$(sql "select has_database_privilege('$role', '$db', 'CONNECT')")" = "t" ]; then
      echo "  STILL REACHABLE: $role -> $db"
      FAILED=1
    fi
  done
done
[ "$FAILED" -eq 0 ] && echo "  neither $PLATFORM_ROLE nor $ROLE can open any customer database"

if [ "$(sql "select rolcreatedb from pg_roles where rolname = '$ROLE'")" = "t" ]; then
  echo "  $ROLE can create its own databases"
else
  echo "  $ROLE CANNOT create databases - validation will not work"
  FAILED=1
fi

if [ "$(sql "select rolsuper from pg_roles where rolname = '$ROLE'")" = "f" ]; then
  echo "  $ROLE is not a superuser"
else
  echo "  $ROLE IS a superuser - that defeats the point"
  FAILED=1
fi

echo
echo "-----------------------------------------------------------------------"
echo "  Add these to .env:"
echo
echo "    VALIDATION_ENABLED=true"
echo "    VALIDATION_DB_USER=$ROLE"
echo "    VALIDATION_DB_PASSWORD=$PASSWORD"
echo "    ODOO_RUNTIMES=19.0=/home/masbintang/linkederp/base/odoo"
echo "    ODOO_SHARED_ADDON_PATHS=/home/masbintang/linkederp/base/enterprise"
echo
echo "  The password is printed once, to this terminal. It is not written to a file."
echo "-----------------------------------------------------------------------"

if [ -n "$DATABASES" ]; then
  echo
  echo "  To undo the CONNECT changes:"
  for db in $DATABASES; do
    echo "    GRANT CONNECT ON DATABASE \"$db\" TO PUBLIC;"
  done
fi

exit "$FAILED"
