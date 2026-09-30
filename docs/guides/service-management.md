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
| `frontend/src` | rebuild `frontend/.next` (below), after which `cartenz-portal` restarts itself — expect a 1–3 minute 502 |
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

  If either variable is missing from the build shell, `next.config.mjs` falls back to
  `http://localhost:4000` and bakes *that* into the bundle. The portal then loads, but
  every browser shows "Could not reach the API. Check that the backend is running."
  because it calls localhost on the user's own laptop. Check a finished build with
  `grep -rl localhost:4000 .next/static/chunks/` — it must print nothing.

  **Build into a staging directory, not over the live `.next`.** `next build` in place
  deletes and rewrites the directory `cartenz-portal` is serving from, so the portal is
  down for the whole build — and stays down if the build is interrupted. Set
  `NEXT_DIST_DIR` to build aside, then swap and restart:

  ```bash
  cd /opt/cartenz/frontend
  rm -rf .next.new
  NODE_ENV=production NEXT_DIST_DIR=.next.new \
    NEXT_PUBLIC_API_URL=https://<domain> NEXT_PUBLIC_WS_URL=wss://<domain>/ws npm run build
  grep -rl localhost:4000 .next.new/static/chunks/     # must print nothing
  rm -rf .next.old && mv .next .next.old && mv .next.new .next
  git -C /opt/cartenz checkout -- frontend/next-env.d.ts frontend/tsconfig.json  # build rewrites both
  sudo systemctl restart cartenz-portal
  ```

  `.next.old` is the rollback: `mv .next .next.bad && mv .next.old .next` and restart.
  All of this must run as `cartenz`: a single root-owned file in `.next` blocks every
  later build with `EACCES`, and only root can clear it.

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

### The portal's build (`frontend/.next`)

The same gate applies to the frontend, for a different reason: that build is where the
browser's API URL comes from, and one that ran without the two `NEXT_PUBLIC_*` values
exported is not a failing build at all — it is a build that tells every visitor's browser
to call `http://localhost:4000`.

**"Could not reach the API. Check that the backend is running." is almost never a dead
backend.** That string comes from the catch block in `frontend/app/login/page.tsx` and
`register/page.tsx`, and it is printed for *any* failure that is not an `ApiError`, so it
never names the real cause. Read the bundle before touching the services — all five units
can be green while this is wrong:

```bash
grep -rho "localhost:4000\|https://<domain>" /opt/cartenz/frontend/.next/static/chunks/*.js \
  | sort | uniq -c
```

`http://localhost:4000` there means the bundle is wrong. Only the domain, with zero
occurrences of `localhost:4000`, is a good build. Confirm the API is innocent from the
domain's own origin — an expected `401` proves the whole path works:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<domain>/api/v1/auth/login \
  -H 'Content-Type: application/json' -H 'Origin: https://<domain>' \
  -d '{"email":"cek@example.com","password":"salah-sekali-panjang"}'
```

Rebuild as `cartenz`, never as root — and prefer the script, which exists so this
cannot be got wrong by hand:

```bash
/opt/cartenz/infrastructure/scripts/build-portal.sh          # build + verify
/opt/cartenz/infrastructure/scripts/build-portal.sh --verify-only   # check what is on disk
```

It exports exactly the two `NEXT_PUBLIC_*` values (read from `.env` as values, never
sourced), moves a root-owned `.next` aside, runs the build, and then **reads the emitted
bundle back** and fails if `localhost:4000` is in it or the configured URL is not. A build
that exits 0 proves nothing about what it emitted, which is why the check is part of the
build rather than a thing someone remembers afterwards. It also refuses to run as root.

By hand, the same thing:

```bash
cd /opt/cartenz/frontend
mv .next .next.broken-root-$(date +%Y%m%d-%H%M%S)
NODE_OPTIONS=--max-old-space-size=1024 env -u NODE_ENV \
  NEXT_PUBLIC_API_URL=https://<domain> NEXT_PUBLIC_WS_URL=wss://<domain>/ws \
  npm run build
ls -ld .next                                   # must be cartenz-owned
```

Three parts of that are not obvious:

- **The `mv` is not optional after a root-run build.** A root `next build` leaves ~200
  root-owned files under `.next/static`, which `cartenz` cannot overwrite: the next build
  dies with `EACCES: permission denied, unlink '.../.next/...'`. The rename need only
  write on the parent (`frontend/` is `cartenz`-owned), whereas deleting the contents
  needs write on `.next/static` itself, which `cartenz` does not have — the same shape as
  the `dist/` recovery above.
- **Renaming `.next` takes the running portal down with it.** `next start` reads the
  directory while serving, so the rename kills it and `Restart=always` relaunches it into
  a `.next` with no `BUILD_ID` yet: `/var/log/cartenz/portal.log` fills with `Could not
  find a production build in the '.next' directory` and `NRestarts` climbs until the build
  writes `BUILD_ID` (~50 s), at which point it recovers on its own. A frontend rebuild
  therefore costs a 1–3 minute portal outage — expected, not a fault to chase, and not
  something to "fix" with another manual restart. If you have the root shell anyway,
  stopping the portal first is tidier than watching it crash-loop.
- **The `NODE_OPTIONS` cap is deliberate.** It makes V8 collect instead of growing until
  the kernel OOM killer picks a victim, which on a 2 GB host running five units can be
  `cartenz-api`.

Verify what is actually being served before declaring recovery — the chunk hash the
portal hands out must be the file on disk:

```bash
curl -s http://127.0.0.1:3000/login | grep -o 'chunks/193-[a-f0-9]*\.js' | sort -u
ls /opt/cartenz/frontend/.next/static/chunks/193-*
```

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

## Web push (ADR-065): rotating VAPID keys

Approval / completion / failure push notifications sign every message with a
VAPID key pair in `.env` (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`,
`VAPID_SUBJECT`), read by `cartenz-api` and `cartenz-worker`.

Generate a pair once and keep it - **rotating it is destructive**: every
browser currently subscribed was subscribed against the old public key, and a
push signed with a new private key is rejected by the push service for every
one of them. There is no server-side way to un-break an existing subscription;
each person has to open the portal again (which re-subscribes automatically if
they already granted permission) to get a working one.

```bash
cd /opt/cartenz/backend
node -e "console.log(JSON.stringify(require('web-push').generateVAPIDKeys()))"
```

Put the two keys into `/opt/cartenz/.env`:

```
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:ai-agent@linkederp.com
PORTAL_PUBLIC_URL=https://<domain>
```

then `sudo systemctl restart cartenz-api cartenz-worker`. Blank or missing
keys turn push off cleanly (`GET /api/v1/notifications/config` reports
`enabled: false`, and the account page explains that push isn't configured) —
there is no crash from an absent pair, only silence.

To confirm push is live after a restart: sign in, Account → Notifications →
Turn on notifications → Send test. A `sent: 0` result with no error means the
keys are read but no browser is registered yet for that account.

