#!/usr/bin/env bash
# Builds the backend and the frontend for the local runtime (ADR-012).
#
# NODE_ENV is forced to production for the Next.js build: a build run with
# NODE_ENV=development produces a broken error page, and the .env used by the
# local stack sets development for the API.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "Building backend"
( cd "$ROOT/backend" && npx nest build )

echo "Building frontend"
if [ -f "$ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env"
  set +a
fi
( cd "$ROOT/frontend" && NODE_ENV=production npx next build )

echo "Build complete."
