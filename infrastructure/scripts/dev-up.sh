#!/usr/bin/env bash
# Starts the full local stack without Docker (ADR-012).
#
# The supported developer path is infrastructure/compose/docker-compose.yml.
# This script exists for hosts with no container runtime and no root, and starts
# the same processes with the same arguments and the same .env contract.
#
#   Redis     -> 6379 (local build in ~/.local/bin)
#   API       -> API_PORT (default 4000), REST and /ws
#   Worker    -> BullMQ consumer
#   Frontend  -> FRONTEND_PORT (default 3000)
#
# Logs and pid files are written to .runtime/, which is git-ignored.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNTIME="$ROOT/.runtime"
mkdir -p "$RUNTIME"

export PATH="$HOME/.local/bin:$PATH"

if [ ! -f "$ROOT/.env" ]; then
  echo "No .env found. Running bootstrap-env.sh first."
  "$ROOT/infrastructure/scripts/bootstrap-env.sh"
fi

# Export .env so the child processes and this script see the same values.
set -a
# shellcheck disable=SC1091
. "$ROOT/.env"
set +a

REDIS_PORT="${REDIS_PORT:-6379}"
API_PORT="${API_PORT:-4000}"
FRONTEND_PORT="${FRONTEND_PORT:-3000}"

start_process() {
  local name="$1"; shift
  local pidfile="$RUNTIME/$name.pid"

  if [ -f "$pidfile" ]; then
    local existing
    existing="$(cat "$pidfile")"
    # Tested as a process group, matching dev-down: a service started through a
    # wrapper has children that outlive the pid alone.
    if kill -0 -- "-$existing" 2>/dev/null || kill -0 "$existing" 2>/dev/null; then
      echo "  $name already running (pid $existing)"
      return 0
    fi
  fi

  # setsid detaches the process into its own session, so it survives the shell
  # that started it. Without this the services die on SIGHUP the moment the
  # terminal closes, which is the whole point of a background dev stack.
  setsid nohup "$@" >"$RUNTIME/$name.log" 2>&1 < /dev/null &
  echo $! >"$pidfile"
  echo "  $name started (pid $(cat "$pidfile")), logging to .runtime/$name.log"
}

wait_for() {
  local label="$1" ; local attempts="$2" ; shift 2
  for _ in $(seq 1 "$attempts"); do
    if "$@" >/dev/null 2>&1; then
      echo "  $label is up"
      return 0
    fi
    sleep 1
  done
  echo "  $label did not come up in ${attempts}s" >&2
  return 1
}

echo "1. Redis"
if ! command -v redis-server >/dev/null 2>&1; then
  echo "  redis-server not found; building a local copy"
  "$ROOT/infrastructure/scripts/install-redis-local.sh"
fi
start_process redis redis-server --port "$REDIS_PORT" --save '' --appendonly no
wait_for "Redis" 15 redis-cli -p "$REDIS_PORT" ping

if [ ! -d "$ROOT/backend/dist" ] || [ ! -d "$ROOT/frontend/.next" ]; then
  echo "1b. Build (no existing build found)"
  "$ROOT/infrastructure/scripts/build.sh"
fi

echo "2. Database migrations"
( cd "$ROOT/backend" && npm run --silent db:migrate )

echo "3. API"
start_process api node "$ROOT/backend/dist/main.js"
wait_for "API" 30 curl -fsS "http://127.0.0.1:$API_PORT/api/v1/health"

echo "4. Agent worker"
start_process worker node "$ROOT/backend/dist/worker.js"

echo "5. Frontend"
# next start requires NODE_ENV=production; the shared .env sets development for
# the API, so it is overridden for this process only.
start_process frontend env NODE_ENV=production "$ROOT/node_modules/.bin/next" start "$ROOT/frontend" -p "$FRONTEND_PORT"
wait_for "Frontend" 60 curl -fsS "http://127.0.0.1:$FRONTEND_PORT"

echo
echo "Stack is up."
echo "  Portal   http://localhost:$FRONTEND_PORT"
echo "  API      http://localhost:$API_PORT/api/v1"
echo "  Health   http://localhost:$API_PORT/api/v1/health/ready"
echo
echo "Stop with infrastructure/scripts/dev-down.sh"
