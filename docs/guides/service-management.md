# Starting, stopping and restarting the Cartenz services

Everything Cartenz needs at runtime is five systemd units. They are separate on
purpose — the API can be up while the worker is being replaced — so "restart Cartenz"
is never one command by accident. This guide is the one command per intent, the order
that is safe, and what each restart does and does not fix.

## The five units

| Unit | Runs | Listens on | If it is down |
| --- | --- | --- | --- |
| `cartenz-api` | `/opt/cartenz/backend/dist/main.js` as `cartenz` | `0.0.0.0:4000` (proxied at `/api/`, `/ws`) | Portal still loads, every API call answers **502** — including the login POST |
| `cartenz-worker` | `/opt/cartenz/backend/dist/worker.js` as `cartenz` | nothing (polls Postgres/Redis) | Tasks stay `queued` forever; the agent never runs |
| `cartenz-portal` | `next start -p $FRONTEND_PORT` in `/opt/cartenz/frontend` | `0.0.0.0:3000` (proxied at `/`) | Nothing loads at all on the domain |
| `9router` | `/opt/9router/app/custom-server.js` | `127.0.0.1:20128` | No model calls — planning, `chat` and `change` tasks all fail |
| `hermes-api` | `hermes_cli.main gateway run` | `127.0.0.1:8642` | Only if Hermes is selected as the provider for an organisation |

Two of these are easy to forget and both are load-bearing: **`9router` is the model
engine**, and Hermes' own config routes through it, so a dead `9router` breaks the
agent session itself and not just the app. Check all five before calling an outage a
mystery — a healthy-looking API with a dead gateway fails every task with a provider
error.

Boot-time dependencies are already declared in the unit files (`cartenz-worker` and
`cartenz-portal` come `After=cartenz-api.service`), so `systemctl start` on the group
resolves the order for you. When stopping by hand, go the other way: stop what is in
front before what is behind it.

## Reading status without root

The `cartenz` user (which owns `/opt/cartenz`) has **no sudo**. Every command in the
restart sections below is root, and `systemctl restart` is *not* in the provisioning
sudoers allow-list, so no sudoers rule will ever make it work from an unprivileged
shell — it is meant to be typed by whoever holds root. Diagnosis, however, needs no
privileges at all:

```bash
# one line per unit: active state, restart count, when it last started
for u in cartenz-api cartenz-worker cartenz-portal 9router hermes-api; do
  printf '%-16s %-10s restarts=%-6s since=%s\n' "$u" "$(systemctl is-active "$u")" \
    "$(systemctl show "$u" -p NRestarts --value)" \
    "$(systemctl show "$u" -p ActiveEnterTimestamp --value)"
done

# who is actually listening where it should be
ss -tlnp | grep -E ':(3000|4000|20128|8642)'

# logs written by the units themselves
tail -n 40 /var/log/cartenz/api.log
tail -n 40 /var/log/cartenz/worker.log
tail -n 40 /var/log/cartenz/portal.log
tail -n 40 /var/log/cartenz/9router.log
```

`NRestarts` is cumulative for the unit's whole life, so a large number is only a
signal when it is paired with a **recent** `ActiveEnterTimestamp` — that combination
means the unit is crash-looping right now, and the log (not a restart) is what you
want next.

Timestamps are also the honest way to confirm someone else's restart landed:
`ActiveEnterTimestamp` must *move*. A restart that "seemed to work" but left the
timestamp alone is the failure mode seen in practice when the command was typed into
the wrong shell.

## Start / stop / restart

Run as root on the server.

```bash
# start everything (order comes from the units' After= declarations)
sudo systemctl start cartenz-api cartenz-worker cartenz-portal 9router hermes-api

# stop everything (reverse order: portal, then the agent runtime, then the gateway)
sudo systemctl stop cartenz-portal cartenz-worker cartenz-api 9router hermes-api

# restart everything
sudo systemctl restart 9router cartenz-api cartenz-worker cartenz-portal hermes-api
```

One unit at a time is fine and often the right thing:

```bash
sudo systemctl restart cartenz-api          # after a backend build
sudo systemctl restart cartenz-worker       # after a build, or after .env changes
sudo systemctl restart cartenz-portal       # after frontend/.next changes
sudo systemctl restart 9router              # after provider/credential work
sudo systemctl restart hermes-api           # after Hermes config changes

sudo systemctl status cartenz-api --no-pager -l   # full state + last log lines
```

All five are `enabled`, so they already come back after a reboot — `systemctl start`
is for a service you deliberately stopped, not for boot.

`nginx` is the sixth moving part and it is not a Cartenz unit: apply proxy changes with
`sudo nginx -t && sudo systemctl reload nginx`. A reload is enough for config edits;
it does not need a full restart.

## When a restart is actually needed

Restarting more than necessary loses in-flight work for no reason. What each change
needs:

| Change | What it takes |
| --- | --- |
| Model provider row in the portal (Settings → Model providers) | **nothing** — read from the database per task |
| `/opt/cartenz/.env` | restart `cartenz-api` **and** `cartenz-worker` (the units read the file once, at start) |
| `backend/src` | rebuild `backend/dist`, then restart `cartenz-api` + `cartenz-worker` |
| `frontend/src` | rebuild `frontend/.next`, then restart `cartenz-portal` |
| `infrastructure/systemd/*.service` | copy to `/etc/systemd/system/`, `sudo systemctl daemon-reload`, then restart the affected units |
| Nothing at all, but the unit is in `activating (auto-restart)` | fix the cause; see "Crash-looping units" below |

Two traps in that table:

- **An edited `.env` is invisible until the restart, and the drift is silent.** The
  file looks right, the feature is off, nothing errors. To see what a *running*
  process actually holds, bypass systemd's bookkeeping and read the process:

  ```bash
  tr '\0' '\n' < /proc/$(systemctl show cartenz-api -p MainPID --value)/environ \
    | grep '^GITHUB_TOKEN='
  ```

- **The portal bakes `NEXT_PUBLIC_*` at `next build` time.** Those values are compiled
  into the browser bundle, so a changed `NEXT_PUBLIC_API_URL` or `NEXT_PUBLIC_WS_URL`
  needs a frontend *rebuild*, not a restart. Build with both exported explicitly:

  ```bash
  cd /opt/cartenz/frontend
  NEXT_PUBLIC_API_URL=https://<domain> NEXT_PUBLIC_WS_URL=wss://<domain>/ws npm run build
  sudo systemctl restart cartenz-portal
  ```

  Do not `source /opt/cartenz/.env` to get those two into the build shell: it also sets
  `NODE_ENV=development`, and `next build` under a non-production `NODE_ENV` fails with
  an unrelated-looking `<Html> should not be imported outside of pages/_document` error.

## Restarting after a code change: build first, and check the build

`cartenz-api` and `cartenz-worker` run `backend/dist`, so a source edit is not live
until `dist` is rebuilt — and `dist` is the one artefact a build *deletes before it
recreates*, so a build that dies part-way leaves a `dist/` with no entrypoints in it.

**On this host `npm run build` cannot finish** (the type check needs more than 1.4 GB;
see `server-setup-from-scratch.md` §9.2). Use the emit-only build, then verify before
restarting anything:

```bash
cd /opt/cartenz/backend
rm -rf dist
npx tsc -p tsconfig.build.json --noCheck      # ~270 MB, ~30 s; emits main.js + worker.js
find dist -name '*.js' | wc -l                # 150 = complete, ~57 = truncated
ls -ld dist                                   # must be cartenz-owned
```

Only then:

```bash
sudo systemctl restart cartenz-api cartenz-worker
```

The gate matters: with `Restart=always` and `StartLimitIntervalSec=0` on both units, a
missing `dist/main.js` does not fail loudly — it turns into an endless silent restart
loop, which is exactly how "the portal loads but login answers 502" happens. Never
restart onto a `dist/` you have not looked at.

## Crash-looping units

Symptom: `systemctl is-active` says `activating`, `NRestarts` is in the thousands, and
the log repeats the same error every 5 seconds.

A restart is the wrong response — the units are already restarting themselves every 5
seconds, and `StartLimitIntervalSec=0` means there is no burst limit to trip, so they
will retry forever. Fix the cause and they pick it up on their own within ~5 s.
The two causes worth checking first:

```bash
tail -n 20 /var/log/cartenz/api.log
# Cannot find module '/opt/cartenz/backend/dist/main.js'  -> truncated build, see above

systemctl show cartenz-api -p MainPID --value     # PID churn = still looping
```

Both units self-heal once `dist/main.js` / `dist/worker.js` exist again, so no restart
is needed for that failure mode; a restart *is* needed when the old code is still
loaded and serving (a `dist/` that was stale but complete).

## Stopping the worker interrupts a task for good

`cartenz-worker` runs the agent workflow in-process, and there is **no resume
endpoint** — tasks interrupted by a stop or an outage cannot be continued. The
workspace is released with the run, and re-submitting the request creates a new task.
So treat stopping the worker as a destructive action: don't do it while a task is
mid-flight if you can wait, and expect to re-submit whatever was running.

## What not to do

- **Don't kill processes instead of using systemd.** `pkill -f node`, `kill -9` on the
  unit's PID — all of it leaves systemd to restart the unit anyway, and you lose the
  state in `systemctl status` that tells you what happened.
- **Never start the vendor `9router` CLI.** `9router` the command is not a client for
  the running unit: it starts a *second* server on `0.0.0.0:20128`, colliding with the
  unit, and its cleanup `kill -9`s other `next-server` processes — which takes
  `cartenz-portal` down with it. Manage the gateway with `systemctl`, and reach its
  TUI/dashboard as described in `9router-gateway.md`.
- **Don't `systemctl daemon-reload` for a `.env` change.** That is only for unit-file
  edits; config comes from `EnvironmentFile` at process start.
- **Don't restart everything as a first move.** Check which unit is actually down
  first (`ss -tlnp`, the per-unit table above); a blanket restart destroys the evidence
  and interrupts work.

## Verifying recovery

```bash
# 1. units are active, not auto-restarting, with a fresh start time
for u in cartenz-api cartenz-worker cartenz-portal 9router hermes-api; do
  printf '%-16s %-10s since=%s\n' "$u" "$(systemctl is-active "$u")" \
    "$(systemctl show "$u" -p ActiveEnterTimestamp --value)"
done

# 2. the ports are actually held
ss -tlnp | grep -E ':(3000|4000|20128|8642)'

# 3. the API is ready, not merely listening
curl -s http://127.0.0.1:4000/api/v1/health/ready
# {"status":"ready","checks":{"postgres":"up","redis":"up"}}

# 4. end to end, through the proxy, on the domain
curl -s -o /dev/null -w 'portal %{http_code}\n' https://<domain>/
curl -s -o /dev/null -w 'api    %{http_code}\n' https://<domain>/api/v1/health
curl -s -o /dev/null -w 'login  %{http_code}\n' -X POST https://<domain>/api/v1/auth/login \
  -H 'Content-Type: application/json' -d '{"email":"probe@invalid.test","password":"x"}'
```

Expected: `active` for all five, all four ports held, `"ready"`, `200` / `200` / `401`.
The login probe is deliberate — a **`401` is the healthy answer** (the credentials are
meant to be wrong) and it proves the whole chain Nginx → API → Postgres works. A `502`
there means `cartenz-api` is down, whatever `systemctl` says about the portal.

## Odoo project instances are not Cartenz units

Each project the platform provisions gets its own `odoo-<name>.service` and its own
Nginx site. Those are separate from the five units above and are managed the same way:

```bash
systemctl list-units 'odoo-*' --no-pager --plain
sudo systemctl restart odoo-<name>
```

Stopping the Cartenz units does not stop the projects: the customer's Odoo keeps
serving.
