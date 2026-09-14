# Guide: Setting Up Cartenz on a Server From Scratch

This is the end-to-end path for moving Cartenz to a fresh Linux server: what to
install, in what order, how to wire the model engine (including Hermes), and how
to verify each layer. It orchestrates the existing reference documents rather than
repeating them — follow the links for the detail of each step.

Reference documents in this repository:

- `docs/INSTALL-SERVER.md` — the canonical 12-section install guide (packages,
  database, gateway, systemd, TLS, backup, troubleshooting).
- `docs/INSTALL-SERVER-EXISTING-ODOO.md` — what changes when the server already
  runs Odoo (base/enterprise/venv/PostgreSQL paths).
- `docs/guides/creating-and-running-projects.md` — using the platform once it is
  up.

Target OS: Ubuntu 22.04 LTS. All commands assume `sudo` on the target host.

---

## 1. Decide the Shape Before You Start

Answer these three questions first; they determine several later steps.

### 1.1 Does this server already run Odoo?

- **No (generic install):** follow `INSTALL-SERVER.md` as written. Odoo source
  for validation is optional and added later.
- **Yes (existing Odoo estate):** follow `INSTALL-SERVER.md` for the platform,
  and `INSTALL-SERVER-EXISTING-ODOO.md` for the paths. The golden rule there:
  Cartenz **reads** the Odoo base/enterprise source and **never** owns or writes
  it; it writes only under its own projects root.

### 1.2 Which model engine will Cartenz use?

Cartenz does not contain a model. It calls one **OpenAI-compatible HTTP
endpoint**, chosen per organisation as a priority chain (ADR-020/023). You have
three options, and they can be combined in one chain:

| Engine | What it is | Best for | Trade-off |
|---|---|---|---|
| **9router** (default) | Local gateway holding provider keys, many models behind one URL | The standard setup; fast, flexible | You manage provider keys in the gateway |
| **Hermes** (optional) | Agent-backed OpenAI-compatible API (`:8642`) | `chat` tasks; accumulating per-project memory | Slow (~12 min/call); large `change` plan schema fails and falls over to the next provider |
| **Anthropic direct** | Claude via Anthropic's API | Simple, reliable `change` planning | Needs an Anthropic key; no local gateway features |

**Recommendation for most servers:** 9router as the gateway, with Claude
(`cc/claude-sonnet-5`) at priority 1 for both `chat` and `change`. Add Hermes
only if you specifically want its per-project memory for conversational work
(see §6). Hermes is **not required** for Cartenz to function.

### 1.3 Will the agent push to customer repositories and run Odoo tests?

- Start with `GIT_PUSH_ENABLED=false`, `GITHUB_REPOSITORY_ENABLED=false` and
  `VALIDATION_ENABLED=false`. Pushing and repository creation are refused at the
  process layer, not just by policy. Turn them on deliberately once the platform
  behaves as expected (§7, §8 of `INSTALL-SERVER.md`).

### 1.4 Should a project created here also get a repository on GitHub?

Optional, and off by default. With `GITHUB_REPOSITORY_ENABLED=true` plus a
`GITHUB_TOKEN` and `GITHUB_OWNER`, creating a project also creates its repository
on GitHub — private unless you set `GITHUB_REPOSITORY_VISIBILITY=public` — points
the project's repository at it, and pushes its `main`, `staging` and `development`
branches. All three settings are required: switch on with a token or owner missing
leaves the feature **off** rather than failing at project-creation time.

`GIT_PUSH_ENABLED=true` must also be set, or the whole feature is inert: the
process layer would refuse the push that populates the repository. A created
project with `GIT_PUSH_ENABLED=false` and a working token reports "skipped" and
gets no repository.

The token is a deployment credential: it creates repositories and is then sealed
per project through the secrets store as that project's `github` connection, which
is what a task's push reads. It is never logged and never returned in a response.
A classic PAT with `repo` scope works; the fine-grained equivalent needs
**Administration: read and write** (to create the repository under the owner) and
**Contents: read and write** (to push).

Projects created *before* this is enabled keep their local repository and have no
remote. `npm run github:backfill` in `backend/` walks them and does what creation
now does, idempotently — run it with `--dry-run` first to see the plan.

### 1.5 Should a task push without waiting for an approval?

`GIT_AUTO_PUSH_ON_TASK=true` (with `GIT_PUSH_ENABLED=true`) makes a task that
targets a `development` or `staging` environment push as soon as it commits,
instead of parking in `waiting_approval` until a person approves the push.

The gate is not removed, it is moved: the deployment asks once, in configuration.
`production` is unreachable either way — a task cannot target it at all (refused
at task creation, ADR-021). A task with no resolved environment keeps the
approval. Every auto-approved push is recorded as `task.push_auto_approved`, so
"who authorised this" has an answer beyond the configuration file.

---

## 2. Install the Platform (fastest path)

The repository ships an idempotent installer that performs sections 2–6 and 9 of
`INSTALL-SERVER.md`. Preview it first — it changes nothing in dry-run:

```bash
sudo -u cartenz git clone <your-repository-url> /opt/cartenz   # or place the code there
cd /opt/cartenz

sudo DRY_RUN=1 ./infrastructure/scripts/install-server.sh   # prints the plan
sudo ./infrastructure/scripts/install-server.sh             # performs it
```

What it does: preflight → system packages + Node 22 → the non-root `cartenz`
service account → dependencies → generate `.env` with fresh secrets → create the
`linkederp`/`linkederp_ai` database role → build + migrate → install 9router →
install systemd units → logrotate → health check.

What it deliberately leaves to you: TLS / reverse proxy (§7), Odoo validation
(§8), and the model provider chain (§9). Those are decisions, not defaults.

If you prefer to do it by hand, `INSTALL-SERVER.md` sections 2–6 are the exact
manual equivalent.

### 2.1 Back up the one irreplaceable secret

```bash
sudo cp /opt/cartenz/.env /secure-backup/cartenz.env   # off the server
```

`SECRETS_ROOT_KEY` in `.env` decrypts every stored project credential (ADR-014).
Lose it and every connected repository credential is unrecoverable.

---

## 3. Verify the Base Platform

```bash
systemctl status cartenz-api cartenz-worker cartenz-portal 9router --no-pager
curl -s http://127.0.0.1:4000/api/v1/health/ready
# expect: {"status":"ready","checks":{"postgres":"up","redis":"up"}}
```

The **worker** is the process that runs agent tasks and calls model providers
(ADR-016) — it is the one to watch. Logs are under `/var/log/cartenz/`.

At this point the platform runs but has no model engine wired and no TLS. Continue
below.

---

## 4. Reverse Proxy and TLS

Only the portal (`:3000`) and API (`:4000`) should be reachable from outside; the
gateway (`:20128`), Hermes (`:8642`), Postgres (`:5432`) and Redis (`:6379`) stay
on loopback. Use the nginx block in `INSTALL-SERVER.md §7`, then:

```bash
sudo ufw allow 22/tcp
sudo ufw allow 443/tcp
sudo ufw enable    # 4000/3000/20128/8642/5432/6379 stay closed
```

The WebSocket location matters: an agent task runs for minutes, so set
`proxy_read_timeout 3600s` on `/ws` or the live task stream is cut.

---

## 5. Wire the Model Engine

This is §9 of `INSTALL-SERVER.md`, expanded for the engine choice from §1.2.

### 5.1 Register the first account and organisation

Open `https://cartenz.example.com`, register the first account (it becomes the
organisation owner).

### 5.2 Add the provider chain

Portal → **Settings → Model providers**. The chain is ordered by priority: row 1
is tried first, and the platform falls through to the next on a spent account
(402), rate limit (429), rejected key (401), missing model (404) or server error
(5xx). Use the **Test** button on each row — it makes a real model call.

A dependable chain for most servers:

| Priority | Label | Provider | Model | Structured outputs |
|---|---|---|---|---|
| 1 | Primary | openai-compatible (9router) | `cc/claude-sonnet-5` | on |
| 2 | Fallback | openai-compatible (9router) | `Banyak-duit` | on |
| 3 | Fallback 2 | openai-compatible (9router) | `Paket-Hemat` | off |

**Structured outputs is not cosmetic.** Only some models accept a strict
`json_schema`; a model that refuses it must have the switch **off**, or every
planning (`change`) call against that row fails — and can hang until timeout. If a
provider test hangs, flip the switch off and retest before assuming the model is
dead.

Test provider rows **one at a time** (each row's own Test). The aggregate test
walks the whole chain and can exceed a client timeout at ~5 rows.

If you are not using Hermes, you are done with the engine — skip to §7.

---

## 6. (Optional) Install and Connect Hermes

Hermes is an agent that also exposes an OpenAI-compatible API. Connect it only if
you want its per-project memory for conversational (`chat`) work. It is **not**
required, and it is **not** a replacement for the gateway for `change` tasks (its
large-plan schema handling fails over to the next provider).

### 6.1 Confirm Hermes is running and find its key

Hermes runs as its own process with its own config under `~/.hermes/` (for
whichever user runs it). Confirm the API server is up:

```bash
ss -ltnp | grep 8642
curl -sS http://127.0.0.1:8642/health
# expect: {"status":"ok","platform":"hermes-agent","version":"..."}

# The API key is API_SERVER_KEY in Hermes' own .env
KEY=$(grep -E '^API_SERVER_KEY=' ~/.hermes/.env | cut -d= -f2- | tr -d '"')
curl -sS http://127.0.0.1:8642/v1/models -H "Authorization: Bearer $KEY"
# expect: a model list containing {"id":"hermes-agent",...}
```

Notes:
- Hermes refuses to start without `API_SERVER_KEY`, even on a loopback bind.
- Bind it to `127.0.0.1` only. Like the gateway, it must never be reachable from
  the network — put it behind the firewall, never in the nginx config.
- Hermes reaches its own model provider (per `~/.hermes/config.yaml`), so it does
  **not** depend on 9router. That is deliberate — the two are independent engines.

### 6.2 Probe structured output before wiring it in

Cartenz's planner asks for `response_format: json_schema`. Verify Hermes answers
one:

```bash
curl -sS http://127.0.0.1:8642/v1/chat/completions \
  -H "Content-Type: application/json" -H "Authorization: Bearer $KEY" \
  -d '{"model":"hermes-agent","messages":[{"role":"user","content":"Return JSON: name=test count=3. ONLY JSON."}],
       "response_format":{"type":"json_schema","json_schema":{"name":"r","strict":true,
         "schema":{"type":"object","properties":{"name":{"type":"string"},"count":{"type":"integer"}},
         "required":["name","count"],"additionalProperties":false}}},"stream":false}'
```

A trivial schema passes. This does **not** imply the full `change` planner schema
passes — see §6.4.

### 6.3 Register Hermes as a provider

Portal → **Settings → Model providers → Add**:

- Provider: **openai-compatible**
- Base URL: `http://127.0.0.1:8642/v1` (loopback plain-HTTP is accepted; ADR-023)
- Model: `hermes-agent`
- API key: the `API_SERVER_KEY` value from §6.1
- Structured outputs: **on** (start here; see §6.4)

New rows land at the end of the chain. Reorder so the intended engine is priority
1, and keep a non-Hermes row below it as the fallback.

### 6.4 What to expect, honestly

Verified behaviour, so you plan around it rather than fighting it:

| Task | Result through Hermes |
|---|---|
| `chat` | Completes with a correct answer; scoped per-project memory accumulates |
| `change` (large plan schema) | Planning does not match the schema and **falls over to the next provider** — the plan is then produced by that provider, not Hermes |
| Latency | A single `chat` call runs ~12 minutes end-to-end (Hermes does a full agentic run per call) |

Practical split that works today: **Hermes for `chat`, a gateway/Claude row below
it for `change`.** Because the chain fails over on the schema mismatch, a Hermes
row at priority 1 no longer makes `change` tasks fail outright — but confirm from
the worker log or `agent_model_calls` which provider actually answered, not the
summary field (it reports the chain's first member, not the responder).

### 6.5 Per-project memory

Cartenz scopes Hermes memory per project via the `X-Hermes-Session-Key` header
(`cartenz-project-<projectId>`). No configuration is needed — a fact set in one
call is recalled in the next, and Hermes lists one session per project. This is
the reason to use Hermes at all: it learns each project over time.

---

## 7. (Optional) Odoo Source and Validation

If the agent should read the real Odoo source and run module tests:

1. **Paths.** On a server that already runs Odoo, follow
   `INSTALL-SERVER-EXISTING-ODOO.md`: set `ODOO_SOURCE_PATHS`, `ON_PREMISE_ROOT`,
   `ODOO_RUNTIMES`, `ODOO_SHARED_ADDON_PATHS`, `ODOO_PYTHON` in `.env`, then set
   the same base/enterprise/projects-root in **Settings → Odoo** per organisation
   (the portal is the authority once set; `.env` is the pre-portal fallback).
   - `base_path` must be the Odoo **repo root** (the one holding `odoo-bin`), not
     `odoo/addons`.
   - For a Community project the enterprise path is excluded from both the
     generated `odoo.conf` and what the agent may read (ADR-037).
2. **Validation role.** Validation creates a database and runs code, so it uses a
   dedicated role, never the Odoo superuser:
   ```bash
   sudo -u cartenz bash /opt/cartenz/infrastructure/scripts/create-validation-role.sh
   ```
   Then set `VALIDATION_ENABLED=true` and `VALIDATION_DB_USER`/`_PASSWORD` in
   `.env` and restart the worker.
3. **Interpreter.** `ODOO_PYTHON` must be the venv whose dependencies match the
   runtime, not the system `python3`, or a validation run dies importing Odoo.

Leave `VALIDATION_ENABLED=false` if you do not need it — validation is then
reported as skipped, never faked.

---

## 8. Smoke Test the Whole Path

```bash
# Platform health and honest posture
curl -s http://127.0.0.1:4000/api/v1/health/ready
curl -s http://127.0.0.1:4000/api/v1/health/posture | python3 -m json.tool
```

`health/posture` is the honest answer to "what can this deployment actually do":
whether push is enabled, whether the database is isolated, and whether the AI data
boundary applies to every model call.

Then, in the portal:

1. Create a project (Create with AI or on-premise scaffold). It appears under the
   projects root with `main`/`staging`/`development` branches and a runnable
   `odoo.conf` + `run.sh` (see `docs/guides/creating-and-running-projects.md`).
2. Submit one small task on a non-`main` branch — a `chat` question first (fast,
   proves the engine), then a `change` if validation is configured.
3. If Odoo is wired, confirm the project runs locally: `cd <projects_root>/<name>
   && ./run.sh -i base --stop-after-init && ./run.sh`, then open `:8069`.

---

## 9. Operations

- **Backup (both, or lose data):**
  ```bash
  pg_dump -U linkederp -h 127.0.0.1 linkederp_ai | gzip > cartenz-$(date +%F).sql.gz
  sudo cp /opt/cartenz/.env /secure-backup/cartenz.env   # SECRETS_ROOT_KEY
  ```
- **Upgrade:** stop services → `git pull` → `npm ci` → `npm run build` →
  `npm run db:migrate` → start services. Migrations are forward-only; dump first.
  (Full sequence in `INSTALL-SERVER.md §10.2`.)
- **Restart after `.env` changes:** provider-row edits apply on the next task, but
  `.env` and code changes need a worker rebuild + restart — the worker runs
  `backend/dist`, so an unbuilt change silently does nothing.

### 9.1 Moving an existing deployment to a new server

The installer builds a *working* platform; it cannot build *this* platform, because
part of what makes a deployment this one is not in the repository. Two groups of
things have to travel, and only one of them is code.

**What travels, and what happens if you forget it:**

| Thing | Where it lives | If it is missed |
| --- | --- | --- |
| `SECRETS_ROOT_KEY` | `/opt/cartenz/.env` | **Every stored credential becomes unrecoverable** — repository tokens, Odoo API keys, the per-project GitHub tokens. There is no recovery path (ADR-014). |
| Platform database | Postgres `linkederp_ai` | Every project, task, connection, approval and audit row is gone. |
| `JWT_SECRET` | `/opt/cartenz/.env` | Not fatal — a new one just signs everyone out. Keep it if you want sessions to survive. |
| `GITHUB_TOKEN` / `GITHUB_OWNER` | `/opt/cartenz/.env` | Created projects silently get no repository (the feature reports "skipped"). |
| `AI_BASE_URL` / `AI_API_KEY` / provider chain | `.env` + the portal's per-organisation rows | The agent cannot call a model. The portal rows travel with the database. |
| sudoers rule | `/etc/sudoers.d/99-linkederp-provisioning` | Project provisioning fails with `sudo: a password is required`. Source is in the repo (`infrastructure/provisioning/`); nothing installs it for you. |
| The operator's `create_project` scripts | `/opt/odoo/scripts/` | **Not in this repository.** Without them the platform can still create scaffolded projects, but can never turn one into a running Odoo instance. |
| Project directories | `/opt/odoo/projects/<name>/` | Each holds the project's git repository (`addons/`), its `config/`, `data/` and `logs/`, and its Odoo *database* is a separate database in the same Postgres cluster. Miss this and the projects exist in the portal but not on the host. |
| Per-project units and Nginx sites | `/etc/systemd/system/odoo-*.service`, `/etc/nginx/sites-available/` | Already-provisioned instances stop answering. |
| TLS certificates | `/etc/letsencrypt/` | Every hostname loses HTTPS. Reissuing is usually easier than moving them. |

**Sequence.** The order matters in one place: `.env` must be in place *before* the
installer runs, or the bootstrap generates a fresh `SECRETS_ROOT_KEY` and the
restore is pointless.

On the **old** server:

```bash
# 1. Quiet the platform so nothing writes while it is captured.
sudo systemctl stop cartenz-worker cartenz-api cartenz-portal

# 2. The platform database.
pg_dump -U linkederp -h 127.0.0.1 linkederp_ai | gzip > cartenz-db-$(date +%F).sql.gz

# 3. Every project's own Odoo database (skip if there are none).
sudo -u postgres pg_dumpall --globals-only > cartenz-roles.sql    # roles, including the projects'
for db in $(sudo -u postgres psql -Atc "select datname from pg_database where datname not in ('postgres','template0','template1')"); do
  sudo -u postgres pg_dump "$db" | gzip > "cartenz-odoo-${db}-$(date +%F).sql.gz"
done

# 4. The .env verbatim — this is the one to guard.
sudo cp /opt/cartenz/.env /secure-backup/cartenz.env

# 5. The host-local pieces that are not in the repository.
sudo tar czf cartenz-host-local-$(date +%F).tar.gz \
  /etc/sudoers.d/99-linkederp-provisioning \
  /opt/odoo/scripts /opt/odoo/projects \
  /etc/systemd/system/odoo-*.service \
  /etc/nginx/sites-available /etc/nginx/sites-enabled
```

On the **new** server, in this order:

```bash
# 1. Get the code, as the service user.
sudo useradd --system --create-home --home-dir /opt/cartenz --shell /bin/bash cartenz   # if not yet made
sudo -u cartenz git clone <your-repository-url> /opt/cartenz

# 2. Put .env in place FIRST. The installer will then leave it alone, and the
#    platform comes up with the original SECRETS_ROOT_KEY.
sudo install -o cartenz -g cartenz -m 600 /secure-backup/cartenz.env /opt/cartenz/.env

# 3. Install. It skips an existing .env, so SECRETS_ROOT_KEY survives.
cd /opt/cartenz
sudo DRY_RUN=1 ./infrastructure/scripts/install-vps-full.sh    # prints the plan
sudo ./infrastructure/scripts/install-vps-full.sh

# 4. Restore the databases, then re-run migrations (forward-only, additive).
sudo systemctl stop cartenz-worker cartenz-api cartenz-portal
sudo -u postgres psql -f cartenz-roles.sql
sudo -u postgres pg_restore -d linkederp_ai --clean --if-exists cartenz-db-*.sql.gz   # or psql < file
for f in cartenz-odoo-*.sql.gz; do zcat "$f" | sudo -u postgres psql; done
cd /opt/cartenz && sudo -u cartenz npm run db:migrate

# 5. The sudoers rule — validate before installing, and install to the exact path
#    the code's allow-list names.
sudo visudo -cf infrastructure/provisioning/99-linkederp-provisioning
sudo install -o root -g root -m 0440 \
  infrastructure/provisioning/99-linkederp-provisioning /etc/sudoers.d/99-linkederp-provisioning

# 6. Host-local pieces, then bring it up.
sudo tar xzf cartenz-host-local-*.tar.gz -C /
sudo systemctl daemon-reload
sudo systemctl start cartenz-api cartenz-worker cartenz-portal 9router hermes-api
```

**Verify it is actually the same platform, not a fresh one:**

```bash
curl -s http://127.0.0.1:4000/api/v1/health/ready            # postgres + redis up
curl -s http://127.0.0.1:4000/api/v1/health/posture | python3 -m json.tool
# Projects, tasks and connections came back:
psql "$(grep -E '^DATABASE_URL=' /opt/cartenz/.env | cut -d= -f2-)" \
  -c "select count(*) from projects; select count(*) from project_connections;"
# The .env settings reached the running processes (they read it once, at start):
for u in cartenz-api cartenz-worker; do
  tr '\0' '\n' < /proc/$(systemctl show $u -p MainPID --value)/environ | grep -c '^GITHUB_TOKEN=.\+'
done
# Provisioning still works (proves the sudoers rule AND the unit's sandbox):
sudo -u cartenz sudo -n /opt/odoo/scripts/create_project
```

Two things to do once it is up:

- **Rotate the credentials that travelled.** The `GITHUB_TOKEN` and every provider
  key were copied through a backup file; rotating them is cheap and retires the old
  server's copies.
- **Take the old server out of service** so its units cannot answer on a shared
  hostname, and keep its database dump until the new one has been through a full
  create-a-project cycle.

---

## 10. Security Checklist

- [ ] `.env` is `chmod 600`, owned by `cartenz`; `SECRETS_ROOT_KEY` backed up off the server
- [ ] Postgres, Redis, 9router and Hermes bound to loopback only
- [ ] Only 443 (and SSH) open in the firewall; TLS terminated at the proxy
- [ ] `GIT_PUSH_ENABLED=false` until push is intended; `GITHUB_REPOSITORY_ENABLED=false` until repositories should be created automatically
- [ ] Services run as the `cartenz` user, never root
- [ ] If Odoo is wired: `cartenz` can read base/enterprise but owns neither; validation uses a dedicated role, not the Odoo superuser
- [ ] Provider chain tested row by row; structured-outputs flag correct per model
- [ ] Database backups scheduled and a restore tested

---

## 11. Where to Go for Detail

| Task | Document |
|---|---|
| Full platform install (every step, manual) | `docs/INSTALL-SERVER.md` |
| Server that already runs Odoo (paths, ownership) | `docs/INSTALL-SERVER-EXISTING-ODOO.md` |
| Using the platform (projects, branches, run.sh) | `docs/guides/creating-and-running-projects.md` |
| Architectural decisions | `docs/adr/` (README indexes ADR-011…041) |
