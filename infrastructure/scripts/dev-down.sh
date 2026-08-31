#!/usr/bin/env bash
# Stops everything dev-up.sh started (ADR-012).
#
# Each service is signalled by process group, not by process id. dev-up.sh starts
# every service under setsid, so the recorded pid is its process group leader,
# and a service started through a wrapper - npm, env - has the wrapper as leader
# and the real server as a child. Signalling the pid alone kills the wrapper and
# orphans the server, which then keeps holding its port.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNTIME="$ROOT/.runtime"

# Matches stop_grace_period in the Compose definition. The worker needs most of
# it: BullMQ's blocking read must time out before the worker can close, so a
# shorter wait forces a KILL on an otherwise healthy shutdown.
GRACE_SECONDS="${GRACE_SECONDS:-35}"

if [ ! -d "$RUNTIME" ]; then
  echo "Nothing to stop."
  exit 0
fi

group_alive() {
  # kill -0 on a negative pid tests the process group.
  kill -0 -- "-$1" 2>/dev/null
}

for pidfile in "$RUNTIME"/*.pid; do
  [ -e "$pidfile" ] || continue
  name="$(basename "$pidfile" .pid)"
  pid="$(cat "$pidfile" 2>/dev/null || echo '')"

  if [ -z "$pid" ]; then
    rm -f "$pidfile"
    continue
  fi

  if ! group_alive "$pid" && ! kill -0 "$pid" 2>/dev/null; then
    echo "  $name was not running"
    rm -f "$pidfile"
    continue
  fi

  # TERM the group first: the API and the worker both drain on it.
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true

  stopped=false
  for _ in $(seq 1 "$GRACE_SECONDS"); do
    if ! group_alive "$pid" && ! kill -0 "$pid" 2>/dev/null; then
      stopped=true
      break
    fi
    sleep 1
  done

  if [ "$stopped" = true ]; then
    echo "  $name stopped"
  else
    echo "  $name did not stop within ${GRACE_SECONDS}s; sending KILL"
    kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  fi

  rm -f "$pidfile"
done

# A previous run may have orphaned a server before this fix, so any process still
# holding a stack port is reported rather than left to fail the next start.
for port in "${API_PORT:-4000}" "${FRONTEND_PORT:-3000}" "${REDIS_PORT:-6379}"; do
  holder="$(ss -ltnp 2>/dev/null | grep -oP "(?<=:)${port}(?=\s).*pid=\K[0-9]+" | head -1 || true)"
  if [ -n "$holder" ]; then
    echo "  warning: port $port is still held by pid $holder (orphan from an earlier run)"
  fi
done
