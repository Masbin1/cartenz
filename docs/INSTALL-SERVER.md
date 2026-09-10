# Cartenz — Server Installation Guide

Deployment guide for a single Linux host running the Cartenz platform: API,
agent worker, portal, and the model gateway.

Written for Ubuntu 22.04 LTS. Commands assume `sudo` and a shell on the target
host.

> **Already running Odoo on this box?** Read
> [INSTALL-SERVER-EXISTING-ODOO.md](INSTALL-SERVER-EXISTING-ODOO.md) for the
> path configuration against an existing Odoo estate (base, enterprise, venv,
> PostgreSQL). This guide covers the generic install; that one covers what
> changes when Odoo is already present.

---

## 1. What you are installing

| Component | Purpose | Port | Reachable from |
| --- | --- | --- | --- |
| PostgreSQL 14+ | Platform database (`linkederp_ai`) | 5432 | localhost only |
| Redis 7+ | BullMQ task queue | 6379 | localhost only |
| Cartenz API | REST + WebSocket event stream | 4000 | reverse proxy |
| Cartenz worker | Runs agent tasks, clones repositories | — | n/a |
| Cartenz portal | Next.js interface | 3000 | reverse proxy |
| 9router | OpenAI-compatible model gateway | 20128 | localhost only |
| Hermes API (optional) | Agent-backed model endpoint | 8642 | localhost only |

The API and the worker share one module graph in two processes (ADR-016). The
worker is what clones repositories and calls model providers, so it is the
process to watch and to scale.

### 1.1 Sizing

| Resource | Minimum | Recommended |
| --- | --- | --- |
| CPU | 2 vCPU | 4 vCPU |
| RAM | 4 GB | 8 GB |
| Disk | 20 GB | 50 GB SSD |
| Node.js | 20 LTS | 22 LTS |

Disk is dominated by cloned workspaces under `WORKSPACE_ROOT`. Each task clones
a repository and deletes it when the run ends, but concurrent tasks hold several
clones at once. `WORKSPACE_MAX_BYTES` (default 512 MiB per workspace) bounds one
clone, not the total.

**Add swap — do not skip this on a small box.** A 2 vCPU / 2 GB VPS is below the
minimum above and will not survive the full stack (Postgres + Redis + API +
worker + portal + 9router + Hermes) without swap. With no swap, the kernel has
no headroom: processes are killed mid-request and you get bare `Killed` /
`code=exited, status=137` in the logs with no OOM line in `dmesg`. Create a
swapfile before installing:

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
sudo sysctl -w vm.swappiness=20
echo 'vm.swappiness=20' | sudo tee -a /etc/sysctl.conf
free -h    # Swap: 2.0Gi
```


---

## 2. Prerequisites

> **Shortcut:** `infrastructure/scripts/install-server.sh` performs sections 2
> through 6, 9 and part of 5 in one run. Sections 7 (reverse proxy and TLS), 8
> (Odoo validation) and 9 (first run) still need a person. Preview it first:
>
> ```bash
> sudo DRY_RUN=1 ./infrastructure/scripts/install-server.sh   # changes nothing
> sudo ./infrastructure/scripts/install-server.sh
> ```
>
> The script is idempotent and never overwrites an existing `.env` or database.
> The manual steps below remain the reference for what it does and why.

### 2.1 System packages

```bash
sudo apt update
sudo apt install -y curl git openssl ca-certificates postgresql redis-server
```

### 2.2 Node.js 22 LTS

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version    # expect v22.x
```

### 2.3 Service account

The platform must not run as root: the worker executes git and, when validation
is enabled, an Odoo process.

```bash
sudo useradd --system --create-home --home-dir /opt/cartenz --shell /bin/bash cartenz
sudo mkdir -p /var/log/cartenz
sudo chown cartenz:cartenz /var/log/cartenz
```

---

## 3. Database

Create the role and database. Choose a strong password; it goes into
`DATABASE_URL` and nowhere else.

```bash
sudo -u postgres psql <<'SQL'
CREATE ROLE linkederp WITH LOGIN PASSWORD 'CHANGE_ME';
CREATE DATABASE linkederp_ai OWNER linkederp;
SQL
```

### 3.1 Database isolation (ADR-026)

The platform reports at startup whether its credentials can open other databases
on the host. It never reads them — no tool opens a database — but on a shared
host that is a property of the code rather than of the credentials. To close it:

```bash
sudo -u postgres psql <<'SQL'
REVOKE CONNECT ON DATABASE some_other_db FROM PUBLIC;
REVOKE CONNECT ON DATABASE some_other_db FROM linkederp;
SQL
```

Check the result at any time:

```bash
curl -s http://127.0.0.1:4000/api/v1/health/posture | python3 -m json.tool
```

---

## 4. Application

### 4.1 Deploy the code

```bash
sudo -u cartenz git clone <your-repository-url> /opt/cartenz
cd /opt/cartenz
sudo -u cartenz npm ci
```

### 4.2 Configuration

`bootstrap-env.sh` creates `.env` with freshly generated secrets and refuses to
overwrite an existing one — losing `SECRETS_ROOT_KEY` makes every stored project
credential unrecoverable (ADR-014).

```bash
sudo -u cartenz bash infrastructure/scripts/bootstrap-env.sh
sudo -u cartenz chmod 600 /opt/cartenz/.env
```

Then edit `/opt/cartenz/.env`. The settings that must be reviewed:

| Variable | Set to | Why |
| --- | --- | --- |
| `NODE_ENV` | `production` | Refuses `AI_PROVIDER=mock` and enables production guards |
| `DATABASE_URL` | `postgresql://linkederp:PASSWORD@localhost:5432/linkederp_ai` | |
| `REDIS_URL` | `redis://localhost:6379/0` | |
| `JWT_SECRET` | generated | Rotating it signs every session out |
| `SECRETS_ROOT_KEY` | generated | **Back this up.** Losing it loses every stored credential |
| `AI_PROVIDER` | `openai-compatible` | |
| `AI_BASE_URL` | `http://127.0.0.1:20128/v1` | The gateway; must be loopback over plain HTTP |
| `AI_API_KEY` | your gateway key | |
| `AI_MODEL` | e.g. `cc/claude-sonnet-5` | Environment fallback when an organisation has no chain |
| `GIT_PUSH_ENABLED` | `false` to start | See §7.1 |
| `VALIDATION_ENABLED` | `false` unless §8 is done | Validation is skipped honestly, never faked |
| `WORKSPACE_ROOT` | `/opt/cartenz/.runtime/workspaces` | Must be writable by `cartenz` |
| `FRONTEND_PORT` | `3000` | |
| `API_PORT` | `4000` | |

Configuration is refused at boot rather than failing later: a non-`mock`
provider without `AI_API_KEY`, or an `openai-compatible` provider whose
`AI_BASE_URL` is plain HTTP on a non-loopback host, aborts startup. That second
rule exists because source code and the key travel in the prompt.

### 4.3 Build and migrate

```bash
cd /opt/cartenz
sudo -u cartenz npm run build
sudo -u cartenz npm run db:migrate
```

---

## 5. Model gateway (9router)

Cartenz calls model providers over an OpenAI-compatible endpoint. 9router is the
gateway that holds the provider keys and exposes many models behind one URL.

```bash
sudo npm install -g 9router
sudo ln -s "$(npm root -g)/9router" /opt/9router
```

Install the unit and start it:

```bash
sudo cp /opt/cartenz/infrastructure/systemd/9router.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now 9router
```

The unit binds to `127.0.0.1` deliberately. The gateway holds provider API keys;
it must never be reachable from the network.

### 5.1 Why the unit runs `custom-server.js`, not `cli.js`

`/opt/9router/cli.js` is the interactive launcher and must **not** be the
ExecStart under systemd. Two things go wrong with it, and both are silent:

1. **Restart loop.** With no TTY (and `--skip-update`) the launcher switches to
   "tray mode": it spawns the real server as a *detached* child and then exits.
   systemd tracks the launcher PID, sees it leave, and restarts the unit every
   `RestartSec` — indefinitely. `systemctl show 9router -p NRestarts` climbs into
   the thousands and `9router.log` repeats the banner forever.
2. **It kills the portal.** Every one of those restarts calls the launcher's
   `killAllAppProcesses()`, which runs `kill -9` on every process whose command
   line contains `next-server`. `cartenz-portal` is also a `next-server`, so the
   portal is killed a few seconds after it reports `Ready` and never stays up
   (`status=137`, bare `Killed` in `portal.log`).

The shipped unit therefore runs the standalone server directly:

```ini
WorkingDirectory=/opt/9router/app
ExecStart=/usr/bin/node --dns-result-order=ipv4first --max-old-space-size=2048 /opt/9router/app/custom-server.js
```

Do not "simplify" this back to `cli.js … --skip-update`.

### 5.2 The key store lives under `DATA_DIR`

9router keeps its own API keys **and** its upstream provider credentials in a
SQLite database under `DATA_DIR` (the unit sets `DATA_DIR=/opt/cartenz/.9router`).
Consequences worth knowing before you debug an auth error:

- Point `DATA_DIR` at a path that stays fixed. If it moves — or the unit's
  user/HOME changes so `$HOME/.9router` resolves elsewhere — the gateway starts
  with an **empty** key store and every client gets `Invalid API key`, even
  though the key in `.env` is correct.
- A fresh install has an empty store by design. Feed it here first (§5.3).
- Back this directory up alongside `.env` (§10.1).

Verify:

```bash
systemctl is-active 9router
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:20128/v1/models
```

A cold start syncs the model catalogue and can take up to a minute before the
endpoint answers. That is why the unit sets `TimeoutStartSec=120`.

### 5.3 Feed it a provider, then note the model id

Open the 9router UI (loopback `:20128`; reach it through an SSH tunnel) and add a
provider credential — Anthropic/Claude OAuth, DeepSeek, Z.AI/GLM, etc. Then note
the model id **as 9router actually serves it** — it is prefixed by the provider
(`cc/claude-sonnet-5`, `alicode/glm-5`, …):

```bash
curl -s http://127.0.0.1:20128/v1/models | tr , '\n' | grep -o '"id":"[^"]*"' | sort -u
```

Use that exact id in the portal chain (§9). A model id the gateway does not serve
answers `No active credentials for provider: …` — that is a routing miss, not a
wrong key.

---

## 6. Services

```bash
sudo cp /opt/cartenz/infrastructure/systemd/cartenz-*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cartenz-api cartenz-worker cartenz-portal
```

Check all four:

```bash
systemctl status 9router cartenz-api cartenz-worker cartenz-portal --no-pager
curl -s http://127.0.0.1:4000/api/v1/health/ready
```

Expected: `{"status":"ready","checks":{"postgres":"up","redis":"up"}}`.

Logs are under `/var/log/cartenz/`. Rotate them:

```bash
sudo tee /etc/logrotate.d/cartenz >/dev/null <<'EOF'
/var/log/cartenz/*.log {
  daily
  rotate 14
  compress
  missingok
  notifempty
  copytruncate
}
EOF
```

---

## 7. Reverse proxy and TLS

Only the portal and the API should be reachable. The gateway and the database
must not be.

```nginx
server {
    listen 443 ssl http2;
    server_name cartenz.example.com;

    ssl_certificate     /etc/letsencrypt/live/cartenz.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/cartenz.example.com/privkey.pem;

    # Portal
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # API and the WebSocket event stream
    location /api/ {
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /ws {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        # An agent task runs for minutes; do not cut the stream.
        proxy_read_timeout 3600s;
    }

    # A document upload is capped at 10 MiB by the application (ADR-030).
    client_max_body_size 12M;
}
```

Firewall:

```bash
sudo ufw allow 22/tcp
sudo ufw allow 443/tcp
sudo ufw enable
# 4000, 3000, 20128, 5432 and 6379 stay closed: they are loopback only.
```

### 7.1 Push safety (ADR-021)

`GIT_PUSH_ENABLED=false` means `CommandRunner` refuses any `git push` before the
process starts — not a policy check that can be bypassed, a refusal at the
process layer. Start with it disabled, confirm the platform behaves as expected,
and enable it only when you intend the agent to push to customer repositories.

Production environments are never targetable. Task creation refuses them
outright and audits the refusal.

---

## 8. Odoo validation (optional)

Skip this section and leave `VALIDATION_ENABLED=false` unless you want the agent
to run Odoo tests. Without it, validation is reported as skipped, never faked.

```bash
sudo -u cartenz bash infrastructure/scripts/create-validation-role.sh
```

Then set in `.env`:

| Variable | Meaning |
| --- | --- |
| `VALIDATION_ENABLED` | `true` |
| `ODOO_RUNTIMES` | Path(s) to the Odoo source to run |
| `ODOO_SHARED_ADDON_PATHS` | Extra addon paths |
| `VALIDATION_DB_USER` | `linkederp_validation` |
| `VALIDATION_DB_PASSWORD` | The role's password |

The validation role needs `CREATEDB` and is separate from the platform role, so
a test database cannot touch platform data.

---

## 9. First run

1. Open `https://cartenz.example.com` and register the first account. That
   account creates the organisation and becomes its owner.
2. Go to **Settings → Model providers** and add the chain. Order is priority:
   the first row is tried first, and the platform moves to the next on a spent
   account (402), a rate limit (429), a rejected key (401), a missing model
   (404) or a server error (5xx).

   A working chain looks like this:

   | Priority | Label | Model | Structured outputs |
   | --- | --- | --- | --- |
   | 1 | Primary | `cc/claude-sonnet-5` | on |
   | 2 | Fallback | `Banyak-duit` | on |
   | 3 | Fallback 2 | `Paket-Hemat` | off |
   | 4 | Fallback 3 | `Deepseek` | off |

   **Structured outputs matters.** Only some models accept a strict
   `json_schema`. A model that refuses it must have the switch off, or every
   planning call against that row fails — and, worse, can hang until the request
   times out. Use the **Test** button on each row: it makes a real model call and
   reports the round trip.

3. Create a project, connect a repository, and submit one small task on a
   non-`main` branch as a smoke test.

---

## 10. Operations

### 10.1 Backup

Four things must be backed up. Losing any of them is unrecoverable.

```bash
# Database
pg_dump -U linkederp -h 127.0.0.1 linkederp_ai | gzip > cartenz-$(date +%F).sql.gz

# Secrets — SECRETS_ROOT_KEY decrypts every stored project credential
sudo cp /opt/cartenz/.env /secure-backup/cartenz.env

# 9router key store — the gateway's own API keys AND its upstream provider
# credentials. Losing it means re-adding every provider login by hand.
sudo systemctl stop 9router
sudo cp -a /opt/cartenz/.9router /secure-backup/9router-data
sudo systemctl start 9router

# Hermes config + .env (its API_SERVER_KEY and its own model wiring)
sudo cp -a /opt/cartenz/.hermes/config.yaml /opt/cartenz/.hermes/.env /secure-backup/hermes/
```

### 10.2 Upgrade

```bash
cd /opt/cartenz
sudo systemctl stop cartenz-api cartenz-worker cartenz-portal
sudo -u cartenz git pull
sudo -u cartenz npm ci
sudo -u cartenz npm run build
sudo -u cartenz npm run db:migrate
sudo systemctl start cartenz-api cartenz-worker cartenz-portal
```

Migrations are forward-only. Take a database dump before upgrading.

### 10.3 Health

| Check | Command |
| --- | --- |
| Readiness | `curl -s localhost:4000/api/v1/health/ready` |
| Posture | `curl -s localhost:4000/api/v1/health/posture` |
| Services | `systemctl status cartenz-* 9router` |
| Worker log | `tail -f /var/log/cartenz/worker.log` |

`health/posture` reports whether push is enabled, whether the database is
isolated, and whether the AI data boundary applies to every model call. It is
the honest answer to "what can this deployment actually do".

---

## 11. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| API exits at boot with a configuration error | A guard refused the config | Read the message; it names the variable |
| `AI_PROVIDER is "openai-compatible" but AI_BASE_URL is not set` | Missing gateway URL | Set `AI_BASE_URL` |
| Plain-HTTP base URL refused | Non-loopback host over HTTP | Use `127.0.0.1` or HTTPS |
| Tasks stay `queued` | Worker is down | `systemctl status cartenz-worker` |
| Planning fails: "did not match the schema" | Model cannot honour `json_schema` | Turn structured outputs **off** for that row |
| A provider test hangs until timeout | Same cause as above | Same fix |
| `health/ready` reports `postgres: down` | Credentials or database missing | Check `DATABASE_URL` |
| Portal loads, API calls fail | Proxy not forwarding `/api/` | Check the nginx location block |
| Push refused although enabled | `GIT_PUSH_ENABLED` not applied | Restart the worker after editing `.env` |
| Portal exits `status=137` / bare `Killed` a few seconds after `Ready` | 9router is running `cli.js`, whose `killAllAppProcesses()` kills every `next-server` | Run the standalone server (§5); confirm with `systemctl show 9router -p NRestarts` |
| 9router restarts every few seconds, `NRestarts` in the thousands | Same: `cli.js` tray mode detaches and exits | Same fix |
| Processes killed with **no** OOM line in `dmesg`, memory looks free | No swap on a small box | Add swap (§1.1) |
| 9router answers `Invalid API key` although `.env` is correct | `DATA_DIR` moved / points at an empty key store | Point `DATA_DIR` at the real store (§5); restore from backup |
| 9router answers `No active credentials for provider: X` | Model id not served, or provider not connected in the UI | Add the provider, then use the exact served model id (§5.3) |
| Hermes: `Permission denied: '/root/.hermes.md'` | CLI run from `/root` as a non-root user | Run it from a readable dir — the `hermes` wrapper `cd`s to `/opt/cartenz` |
| Hermes: `HTTP 401 invalid x-api-key` (Anthropic endpoint) | `config.yaml` points `model.provider` at a provider with no key | Repoint it (§6.2 of the from-scratch guide) |


---

## 12. Security checklist

- [ ] `.env` is `chmod 600` and owned by `cartenz`
- [ ] `SECRETS_ROOT_KEY` backed up somewhere other than the server
- [ ] Postgres, Redis and 9router bound to loopback
- [ ] Only 443 (and SSH) open in the firewall
- [ ] TLS terminated at the proxy
- [ ] `GIT_PUSH_ENABLED=false` until push is intended
- [ ] Services run as `cartenz`, never root
- [ ] Log rotation configured
- [ ] Database backups scheduled and a restore tested
