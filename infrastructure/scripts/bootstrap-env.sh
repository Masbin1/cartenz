#!/usr/bin/env bash
# Creates .env from .env.example with freshly generated secrets.
# Refuses to overwrite an existing .env: losing SECRETS_ROOT_KEY makes every
# stored project credential unrecoverable (ADR-014).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TARGET="$ROOT/.env"

if [ -f "$TARGET" ]; then
  echo ".env already exists. Not overwriting."
  exit 0
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl is required to generate secrets." >&2
  exit 1
fi

JWT_SECRET="$(openssl rand -hex 32)"
SECRETS_ROOT_KEY="$(openssl rand -hex 32)"

cp "$ROOT/.env.example" "$TARGET"
sed -i "s|^JWT_SECRET=.*|JWT_SECRET=${JWT_SECRET}|" "$TARGET"
sed -i "s|^SECRETS_ROOT_KEY=.*|SECRETS_ROOT_KEY=${SECRETS_ROOT_KEY}|" "$TARGET"

chmod 600 "$TARGET"

echo "Created $TARGET with generated JWT_SECRET and SECRETS_ROOT_KEY."
echo "Set DATABASE_URL and REDIS_URL for your environment before starting."
