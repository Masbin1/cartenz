# Guide: Creating and Running Odoo Projects in Cartenz

This guide explains how to create an Odoo project in Cartenz and run it locally,
from a user's perspective. It covers the behaviour introduced by ADR-032 through
ADR-038.

Workflow at a glance:

1. Create a project (two entry points: "Create with AI" or "Connect /
   on-premise").
2. Cartenz scaffolds a git directory on the server, complete with an
   `odoo.conf`, a `run.sh`, two environments (Development + Staging), and three
   branches (`main`, `staging`, `development`).
3. Run the project locally with `./run.sh` — no Docker.
4. Assign work to the agent (`change` or `chat`); the task runs on the branch of
   the environment it targets.

---

## 1. Core Concepts

### 1.1 Project types

| Type | Source of code | Scaffolded? |
|---|---|---|
| `ai_project` | Local (Create with AI) | Yes — always |
| `on_premise` | Local | Yes — when the scaffold option is set |
| `repository` | Git remote | No — code comes from the remote |
| `odoo_sh` | Odoo.sh (git remote) | No — code comes from the remote |
| `odoo_online` | Odoo Online instance (JSON-RPC) | No — no filesystem |

This guide focuses on the scaffolded types (`ai_project` and `on_premise`),
because those produce a local directory you can run directly.

### 1.2 Where projects live

A scaffolded project is placed under the organisation's **projects root**:

```
<projects_root>/<technical_name>/
```

- `projects_root` is set in the portal (organisation settings) or by
  `ON_PREMISE_ROOT` on the server. On the current dev box:
  `/home/masbintang/linkederp/projects`.
- `<technical_name>` is derived from the project name: lowercased, with spaces
  and punctuation collapsed to underscores. Example: "PT Angin Ribut" →
  `pt_angin_ribut`.

Important: a project is **not** stored inside the Cartenz repository
(`cartenz_project`). It lives separately under the projects root. To open it from
Windows Explorer under WSL:
`\\wsl.localhost\<distro>\home\masbintang\linkederp\projects`.

### 1.3 Odoo edition (ADR-037)

When creating a project you choose **Community** or **Enterprise**:

- **Enterprise** (default): `odoo.conf` includes base + enterprise; the agent may
  read the enterprise source for reference.
- **Community**: `odoo.conf` includes base only (no enterprise); the agent may
  **not** read the enterprise source.

### 1.4 Environments and branches (ADR-038, ADR-021)

Each environment maps to a git branch. A scaffolded project automatically gets:

| Environment | Branch | Kind | Default target |
|---|---|---|---|
| Development | `development` | development | Yes |
| Staging | `staging` | staging | No |

Plus a `main` branch as the base. Production is never created as an automatic
target (a task refuses to target production).

---

## 2. Creating a Project

### 2.1 Option A — Create with AI (portal)

Menu: **Projects → New → Create with AI**.

Fields:

1. **Project name** — display name (e.g. "Equipment Management").
2. **Odoo version** — 15.0 … 19.0.
3. **Odoo edition** — Community or Enterprise.
4. **Description** — a short description (required).
5. **Requirements** — at least one; these become the structured specification the
   agent works from.

On submit, Cartenz:

- creates the directory `<projects_root>/<technical_name>/`,
- writes `addons/` (empty), `odoo.conf`, `run.sh`, `.gitignore`, `README.md`,
- initialises git on branch `main`, makes the first commit, then creates the
  `staging` and `development` branches,
- creates the Development + Staging environments,
- stores the specification.

### 2.2 Option B — Connect / on-premise (portal)

Menu: **Projects → New**. Choose the **On-premise** type, then:

- Set **Odoo version** and **Odoo edition** as above.
- If you choose to scaffold a new directory, Cartenz builds the same structure as
  Option A.
- Environments: if you declare none, the project gets Development + Staging
  automatically. If you declare your own environments, they are honoured and a
  branch is created for each.

### 2.3 Option C — Direct API

Create with AI:

```bash
curl -X POST http://127.0.0.1:4000/api/v1/projects/ai \
  -H "Authorization: Bearer <TOKEN>" \
  -H 'Content-Type: application/json' \
  -d '{
    "organizationId": "<ORG_ID>",
    "name": "Equipment Management",
    "odooVersion": "19.0",
    "odooEdition": "community",
    "description": "Asset management module.",
    "requirements": [{"title": "Assets", "detail": "Track assets per department"}]
  }'
```

`odooEdition` is optional; omitting it means `enterprise`.

The response includes `environmentConfig.onPremisePath` — that is the project's
directory location.

Connect / on-premise:

```bash
curl -X POST http://127.0.0.1:4000/api/v1/projects \
  -H "Authorization: Bearer <TOKEN>" \
  -H 'Content-Type: application/json' \
  -d '{
    "organizationId": "<ORG_ID>",
    "name": "PT Angin Ribut",
    "projectType": "on_premise",
    "odooVersion": "19.0",
    "odooEdition": "enterprise",
    "scaffold": true
  }'
```

---

## 3. The Generated Project Structure

```
<projects_root>/<technical_name>/
├── .git/                 branches: main, staging, development (HEAD on main)
├── .gitignore            __pycache__, *.pyc, .idea, .vscode
├── README.md             description + how to run
├── odoo.conf             server configuration (per project, editable)
├── run.sh                launcher (executable)
└── addons/
    └── .gitkeep          custom modules go here
```

Contents of `odoo.conf` (Enterprise example):

```ini
[options]
addons_path = /home/masbintang/linkederp/base/odoo/addons,/home/masbintang/linkederp/base/enterprise,addons
db_name = <technical_name>
db_host = 127.0.0.1
db_port = 5432
db_user = odoo
http_interface = 127.0.0.1
http_port = 8069
```

For **Community**, the `addons_path` line omits the enterprise path:

```ini
addons_path = /home/masbintang/linkederp/base/odoo/addons,addons
```

Notes:
- `addons` (the last entry) is written relative to the conf's directory, so a
  moved clone still finds its own modules.
- No password is stored in the file; `run.sh` passes `PGPASSWORD` through.

---

## 4. Running the Project Locally (no Docker)

From inside the project directory:

```bash
cd <projects_root>/<technical_name>

# First run: initialise the database
./run.sh -i base --stop-after-init

# Start the server
./run.sh
```

Then open `http://127.0.0.1:8069`.

`run.sh` forwards extra arguments to `odoo-bin`, so:

```bash
./run.sh -u <module_name>         # update a module
./run.sh -i <module_name>         # install a module
./run.sh --dev=xml                # dev mode (auto-reload XML)
PGPASSWORD=secret ./run.sh        # override the Postgres password
```

Server prerequisites:
- A Python interpreter that can import Odoo (dev box:
  `/home/masbintang/venv/bin/python`, configured via `ODOO_PYTHON`).
- `odoo-bin` present at the base path (dev box:
  `/home/masbintang/linkederp/base/odoo/odoo-bin`).
- Postgres running with the `odoo` role (default password `odoo` on the dev box).

If the base path does not contain `odoo-bin`, Cartenz skips generating
`odoo.conf`/`run.sh` (the project is still created) and logs a warning.

---

## 5. Who Runs What

It is important to distinguish three things:

1. **Running the project as a dev server** — done **by you** via `./run.sh`. The
   AI agent does not start the server.
2. **The AI agent inside a task** — has no shell (by design, per the ADR-013/022
   sandbox). It writes and reviews code; it does not run a server. If asked to
   "run the project", its answer ("no shell available") is correct.
3. **Automatic validation** (optional, `change` tasks) — Cartenz runs
   `odoo-bin --stop-after-init --test-enable` against a scratch database to
   install and test the modules. This is the only path where the platform runs
   Odoo, and even then it is not a live server. It is gated by
   `VALIDATION_ENABLED` and requires the validation role (`VALIDATION_DB_*`).

---

## 6. Assigning Work to the Agent

Two task kinds (ADR-029):

- **`change`** — the development flow: plan → approval → implement → validate →
  commit/push. Writes real modules into `addons/`.
- **`chat`** — conversational: a natural-language answer, no code change; writing
  a file requires inline approval; never commits or pushes.

A task runs on the **branch of the environment** it targets. If no environment is
named, the default target is **Development** (branch `development`). Production
cannot be a target.

For a Community project, the agent reads only the Odoo base source (not
enterprise), matching the edition (ADR-037).

---

## 7. Quick Verification

Check that the project was created correctly:

```bash
DIR=<projects_root>/<technical_name>

# Branches: main, staging, development must all exist
git -C "$DIR" branch --format='%(refname:short)'

# addons_path matches the edition
grep addons_path "$DIR/odoo.conf"

# run.sh is executable
ls -l "$DIR/run.sh"
```

Check the environments via the API:

```bash
curl -s http://127.0.0.1:4000/api/v1/projects/<PROJECT_ID> \
  -H "Authorization: Bearer <TOKEN>" | python3 -m json.tool
```

Relevant fields: `odooEdition`, `environmentConfig.onPremisePath`, and the
`environments` list (Development + Staging).

---

## 8. Common Issues

| Symptom | Cause | Fix |
|---|---|---|
| Project folder empty / missing | Project created via Create with AI before ADR-036, or a repository-backed type | Recreate with the latest build; repository types are intentionally not scaffolded |
| `odoo.conf`/`run.sh` missing | Base path does not contain `odoo-bin` | Set the correct base path in organisation settings (must be the Odoo repo root, not `odoo/addons`) |
| Community still loads enterprise | Paths set via `ODOO_SOURCE_PATHS` (env) instead of the portal | Set base + enterprise in the portal so the edition can separate them |
| `./run.sh` fails to connect to the DB | Different Postgres password | `PGPASSWORD=<pw> ./run.sh` |
| Agent says "no shell, cannot run" | Correct behaviour — the agent does not run a server | Run it yourself via `./run.sh` |
| Validation does not run | `VALIDATION_ENABLED=false` or the validation role is missing | Enable it and create `VALIDATION_DB_*` |

---

## 9. ADR Reference

| ADR | Topic |
|---|---|
| ADR-032 | Scaffold the project's addons directory |
| ADR-033 | Odoo paths in the portal, addons layout |
| ADR-034 | A new project is immediately validatable/runnable |
| ADR-035 | `odoo.conf` + `run.sh` (dev server without Docker) |
| ADR-036 | Create-with-AI is scaffolded locally and runs on-premise |
| ADR-037 | Community/Enterprise edition chosen per project |
| ADR-038 | Staging + development branches at scaffold time |

Full technical decisions are in `docs/adr/`.
