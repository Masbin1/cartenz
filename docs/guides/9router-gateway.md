# Guide: The 9router model gateway

`9router` is the OpenAI-compatible model gateway Cartenz calls for the providers
configured in the portal, and the endpoint Hermes itself routes through. It is a
Next.js application serving both a management dashboard and `/v1/*`, and it holds
the provider credentials (Claude Code OAuth sessions, DeepSeek keys, gateways API
keys) for the whole deployment. Treat its data directory as secret material.

## What runs where

| Item | Value |
| --- | --- |
| Unit | `/etc/systemd/system/9router.service` (root-owned), runs as user `cartenz` |
| Entrypoint | `ExecStart=/usr/bin/node /opt/9router/app/custom-server.js` |
| Bind | `PORT=20128`, `HOSTNAME=127.0.0.1` (loopback only, by design) |
| Data dir | `DATA_DIR=/opt/cartenz/.9router` |
| Log | `/var/log/cartenz/9router.log` (appended by systemd) |
| Package | `/opt/9router` → `/usr/lib/node_modules/9router` (v0.5.75 at the time of writing) |

The unit template in this repository (`infrastructure/systemd/9router.service`)
carried an older `cli.js` entrypoint for a while and drifted from the installed
unit; check `systemctl cat 9router` before trusting the template, and keep the two
in step.

## Never start the vendor CLI on this host

`node /usr/lib/node_modules/9router/cli.js` (the package's `bin`) is not a client
for the running gateway. Before its menu is drawn it calls `killAllAppProcesses()`
— a `kill -9` on every process whose command line contains `next-server`, which
includes `cartenz-portal` — and `killProcessOnPort()`, which takes 20128 away from
the unit and leaves it crash-looping with `EADDRINUSE`. If it is launched from a
terminal that later disappears, the orphaned process keeps holding 20128.

Typing `9router` runs a guard wrapper (`infrastructure/scripts/9router-guard-cli`,
installed to `/usr/local/bin/9router`) instead: the same "Choose Interface" menu,
rebuilt on the vendor's own UI helpers, driving the running gateway over HTTP with
`DATA_DIR=/opt/cartenz/.9router`. The vendor launcher is reachable only
deliberately, with the service stopped (`NINE_ROUTER_ALLOW_LEGACY=1 /usr/bin/9router`).

## Who calls it, and what to change if the port moves

| Caller | Where the address lives |
| --- | --- |
| Cartenz | `organization_model_settings.base_url` (`http://127.0.0.1:20128/v1`), with the gateway key held as a sealed secret (`secret_ref`) |
| Hermes | `/opt/cartenz/.hermes/config.yaml` — `model.base_url` and `custom_providers[0].base_url` — with the key in `/opt/cartenz/.hermes/.env` (`HERMES_CUSTOM_LOCALHOST_20128_API_KEY`) |
| Guard wrapper | `9router status` prints the port; the TUI/menu scripts default to it (`ROUTER_PORT` overrides) |

Moving the port therefore means editing all three, plus the unit file. Anything
less leaves a caller silently pointing at a dead port. Cartenz's *primary* engine
is normally Hermes (`AI_BASE_URL=http://127.0.0.1:8642/v1` in `/opt/cartenz/.env`),
so a dead 9router degrades the provider chain rather than stopping the platform.

## Reaching the dashboard

**Loopback + SSH tunnel (no server change, the safest option).** From the machine
you are sitting at:

```
ssh -N -L 12028:127.0.0.1:20128 <user>@<server>
# then browse http://localhost:12028/login
```

The left-hand number is a port on *your* machine — pick any free one. `ssh -N` with
a bind failure may keep the session open without the forward, so confirm the
tunnel really carries the gateway: `http://localhost:12028/api/version` must answer
`{"currentVersion":"0.5.75",...}` (that endpoint needs no login).

**Published port (convenience, needs one root step).** `infrastructure/proxy/nginx-9router-port.conf`
publishes the dashboard on port `20129` via nginx, leaving the unit on loopback:

```
install -o root -g root -m 0644 infrastructure/proxy/nginx-9router-port.conf \
  /etc/nginx/sites-available/9router-port
ln -sf /etc/nginx/sites-available/9router-port /etc/nginx/sites-enabled/9router-port
nginx -t && systemctl reload nginx
```

then browse `http://<server-ip>:20129`. Removing it is the mirror image (`rm` the
two site links, `nginx -t`, `systemctl reload nginx`); the gateway is untouched.

**Without root (user-level nginx), same port.** Ports above 1024 need no privilege,
so the very same site file can be served by an nginx the `cartenz` user owns:
`/opt/cartenz/.runtime/9router-port/user-proxy.sh start|stop|status`, with a
`@reboot` line in `cartenz`'s crontab for reboot survival (the config under
`/opt/cartenz/.runtime/9router-port/` includes the repo site file, so both routes
behave identically). This is the convenience route for when root is not at hand;
the system nginx site is the durable form. Only one of the two may hold port 20129:
the root installer refuses to run while anything is already listening, because
`systemctl reload nginx` would fail with `Address already in use` and the new site
would silently stay inactive.

Two conditions before publishing, both easy to get wrong:

1. **The dashboard must already have a password.** With no stored password the
   gateway accepts only `INITIAL_PASSWORD` or `123456`, and *that* login is refused
   when the request's Host is not local (HTTP 403, "Default password must be changed
   before remote access"). Set the password from a loopback session (tunnel) first —
   `GET /api/auth/status` must report `"hasPassword":true`.
2. **This port has no TLS.** The dashboard password crosses the network in clear
   text. Prefer the tunnel on untrusted networks, or add `auth_basic` to the site
   block (a second, independent layer in front of the dashboard login).

## Verifying the gateway

```
systemctl status 9router --no-pager -l
ss -tlnp | grep 20128                      # expect 127.0.0.1:20128, owner = unit MainPID
curl -s http://127.0.0.1:20128/api/version  # {"currentVersion":"0.5.75",...}
curl -s http://127.0.0.1:20128/api/auth/status
curl -s http://127.0.0.1:20128/v1/models    # unauthenticated model list
node .hermes/skills/devops/cartenz-platform-ops/scripts/9router-gateway-probe.js
```

A live completion is the only proof a model works — combos can answer `200` by
falling back to a healthy provider, so test the exact model a caller names.

## Failure signatures

| Symptom | Meaning |
| --- | --- |
| `500 {"error":{"message":"a.includes is not a function"}}` for a combo name; log shows `Trying model 1/3: [object Object]` | the combo's `models` holds objects where the runner expects model-id strings. Fix the combo in the dashboard, and check that each entry's provider actually has a connection. |
| `400 {"error":{"message":"Invalid model format"}}` for a combo name | the combo row exists with an empty `models` array (e.g. `free-model`). |
| Portal shows `Not reachable. openai-compatible rejected the request.` | the provider *probe* failed — the Settings page renders `Reachable.`/`Not reachable.` and this message comes from the model-call error mapper, not from a connectivity check. Look at the gateway log and call the model directly before touching URL or key. |
| `unit activating (auto-restart)` + `EADDRINUSE 127.0.0.1:20128`, port listening on `0.0.0.0` with no process column | a stray hand-started instance (usually the vendor CLI, often root) holds the port. Stop the unit, kill the stray, confirm the port is free, start the unit. |
| `[AUTH] Invalid API key (requireApiKey=true)` in the log | the caller's gateway key is wrong or came from another data dir. |
| `404 {"message":"No active credentials for provider: <x>"}` | the model resolves to a provider with no connection in this data dir — add the connection, or use a model id that exists in `GET /v1/models`. |

## Resetting the gateway (total reset)

A total reset wipes `db/data.sqlite`, `auth/cli-secret`, `machine-id`, `jwt-secret`
and the model catalog: **all provider connections, gateway API keys, combos and the
dashboard password are lost**. Every consumer above must be re-wired afterwards, and
`data.sqlite` is the only place some of those credentials exist. Always move the
directory aside rather than deleting it, so the reset stays reversible:

```
systemctl stop 9router
mv /opt/cartenz/.9router /opt/cartenz/.9router.bak-$(date +%Y%m%d-%H%M%S)
mkdir -p /opt/cartenz/.9router
# preserve the vendored runtime: NODE_PATH points at it and the app does not
# re-install it on boot
cp -a /opt/cartenz/.9router.bak-*/runtime /opt/cartenz/.9router/runtime
chown -R cartenz:cartenz /opt/cartenz/.9router
systemctl start 9router
```

Re-wiring checklist after a reset, in order:

1. Set the dashboard password **from a loopback session** (the default-password
   login is refused for non-local hosts), then confirm `"hasPassword":true`.
2. Add provider connections (Providers): API keys, and OAuth re-login for the
   subscription/CLI providers whose models appear under a prefix such as `cc/`.
3. Create or repair combos (Combos): each entry must be a model id string that
   exists in `GET /v1/models`.
4. Create a gateway API key (`/api/keys`) and store it where the callers read it:
   the portal's model-provider row for Cartenz, and
   `HERMES_CUSTOM_LOCALHOST_20128_API_KEY` in `/opt/cartenz/.hermes/.env`.
5. Re-check any model name callers name explicitly — a model that no longer exists
   is seen as a provider failure, not as a configuration mistake.
