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

- Start with `GIT_PUSH_ENABLED=false` and `VALIDATION_ENABLED=false`. Both are
  refused at the process layer, not just by policy. Turn them on deliberately
  once the platform behaves as expected (§7, §8 of `INSTALL-SERVER.md`).

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

---

## 10. Security Checklist

- [ ] `.env` is `chmod 600`, owned by `cartenz`; `SECRETS_ROOT_KEY` backed up off the server
- [ ] Postgres, Redis, 9router and Hermes bound to loopback only
- [ ] Only 443 (and SSH) open in the firewall; TLS terminated at the proxy
- [ ] `GIT_PUSH_ENABLED=false` until push is intended
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
| Architectural decisions | `docs/adr/` (README indexes ADR-011…038) |
