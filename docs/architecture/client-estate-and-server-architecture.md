# Client Estate and Server Architecture

| Field | Value |
| --- | --- |
| Document owner | Lead Software Architect |
| Status | Living document — describes the target and marks what is built |
| Last updated | 17 September 2026 |
| Scope | One client's estate: its Odoo instance, database, code, access, and the servers that carry them |
| Companion | Technical Architecture v1.7 §18 (Client Estate Architecture); `docs/implementation-status.md` |

This document answers one question: **when Cartenz creates and looks after a client's Odoo,
where does everything live, who may touch it, and what is still missing?** It covers the
server architecture, the development architecture (GitHub), the per-client database layout,
and the operational plan for an on-premise server. It ends with a status register of the
operator's requested items — each marked done or not done, with its next step.

It does not repeat the install steps; those are in `docs/guides/server-setup-from-scratch.md`.

---

## 1. Two hosting relationships

Almost every operational question has two answers, decided by who owns the host. This is the
first thing to establish for a client.

| Aspect | Connected server | Linked hosted server |
| --- | --- | --- |
| Ownership of the host | The customer | LinkedERP |
| Custody of root | The customer's administrator | LinkedERP operations |
| How Cartenz reaches it | Installed on that host and working in place, or through the (deferred) connector | Installed on the hosting server it manages |
| Provisioning a new instance | Not performed by the platform; the customer's own process | The operator's `create_project` scripts, behind `PROJECT_PROVISIONING_ENABLED` |
| Custody of backups | The customer's own arrangement | LinkedERP, per client, independent of the platform |
| Security updates and monitoring | The customer's responsibility | LinkedERP's responsibility |
| What the agent may change | The selected project directory only | The client's own project directory only |

The last row is identical in both columns, and deliberately so: whoever owns the host, the
agent's reach is bounded by path containment (`realpath`) and read-only roots rather than by
the trust relationship. A change of ownership does not change what the agent can touch
(ADR-028, ADR-031).

---

## 2. Server architecture

### 2.1 The three servers in play

```
                    ┌─────────────────────────────────────────────┐
                    │  Cartenz platform server (hosting server)    │
                    │  cartenz-api :4000   cartenz-worker          │
                    │  cartenz-portal :3000   9router :20128       │
                    │  PostgreSQL linkederp_ai   Redis :6379       │
                    │  Nginx/TLS (443)                             │
                    └───────────────┬─────────────────────────────┘
                                    │  (per-client Odoo instances on the
                                    │   same host for a linked estate)
              ┌─────────────────────┼──────────────────────┐
              │                     │                      │
   ┌──────────▼─────────┐  ┌────────▼────────┐  ┌──────────▼──────────┐
   │ Client A estate    │  │ Client B estate │  │ Connected / on-prem │
   │ /opt/odoo/projects │  │ /opt/odoo/...   │  │ customer's own host │
   │  /<name>/          │  │                 │  │ Cartenz installed   │
   │  addons/ (git)     │  │                 │  │ in place, or the    │
   │  db <name>         │  │                 │  │ connector (Phase 6) │
   │  odoo-<name>.service│ │                 │  │                     │
   │  nginx server block│  │                 │  │                     │
   └────────────────────┘  └─────────────────┘  └─────────────────────┘
```

- **Platform server** — runs the API, worker, portal, gateway, Postgres and Redis. For a
  linked hosted estate it is also the host of the per-client Odoo instances. Only the portal
  (3000) and API (4000) are exposed; everything else is loopback.
- **Linked hosted server** — a client's estate on the platform's own host, provisioned and
  administered by LinkedERP.
- **Connected / on-premise server** — the customer's host. Cartenz is installed beside their
  Odoo and works the selected directory in place (ADR-026, ADR-028), or reaches it through the
  deferred Phase 6 connector.

### 2.2 The per-client estate on a hosting server

Each client occupies a named, self-contained estate. The elements are created together and
named from the project, so one client can be found, secured, backed up and removed as a unit.

| Element | What it is |
| --- | --- |
| Project directory | `/opt/odoo/projects/<technical_name>/`, created by the operator's provisioning script |
| Addons repository | `<project>/addons/`, the client's own modules under Git; this is the project's repository |
| Database | One PostgreSQL database `<technical_name>`, cloned from the version-and-edition template |
| Filestore | Attachments and generated documents for that database |
| Service unit | `odoo-<name>.service`, on its own allocated port |
| Site and domain | An Nginx server block for the client's own domain, with its certificate |
| Master password | Generated at provisioning, sealed by the secret store, never returned by an ordinary endpoint |
| Odoo source | **Not copied per client**: the shared, read-only checkout for the project's version |

The last row is the centralising decision (ADR-045). Odoo's own source is held once per version
in a catalog of version repositories and is read-only to every project of that version; only
the client's own addons are per client. A new installation therefore costs a database clone
and a configuration file — **not a copy of Odoo, and no model tokens**, because nothing is
generated that already exists on disk.

### 2.3 The per-client estate in version control (GitHub)

Each project has its own repository rather than a directory inside a shared one. The
repository is the client's **addons tree**, and it carries one branch per environment:

| Branch | Role | Agent behaviour |
| --- | --- | --- |
| `development` | Where the agent works; the default target | Tasks land and (if auto-push is on) push here |
| `staging` | Where work is promoted to | Targetable; a push may be auto-approved |
| `main` | The live business | **Never worked on or pushed to directly**; production is not targetable at all |

One repository per client is also the access boundary: a person who should not see a client's
code is not added to that repository, and there is no shared repository from which one client's
code could be read by someone entitled to another client's. Where the platform creates the
repository it also seals the credential as that project's own `github` connection, so one
client's credential is never presented to another client's host (ADR-041, ADR-049).

The route from an agent's change to the live system always passes through a **human
promotion** the platform does not perform:

```
task workspace (/tmp, clone of the target branch)
        │  edit_file / update_file / create_file  (approval-gated)
        ▼
   git_commit  ──►  git_push (development | staging only)
        ▼
   GitHub repository (per client)
        ▼
   Deploy latest  ──►  pull-project.sh  ──►  running Odoo instance
        (admin action, ADR-049)
```

### 2.4 The per-client database layout

- **One database per client**, named from the technical name.
- Cloned from a **template database per version and edition** (`cartenz_tpl_<ver>_ent` /
  `cartenz_tpl_<ver>_com`), built once with every application installed. A new project starts
  full in seconds rather than bare (ADR-045).
- The clone is **neutralised**: `database.uuid` is regenerated and `web.base.url` set per
  project, so no two project databases share an instance identity; the admin password is set
  per project, never baked into the template.
- The platform's own Postgres role must not be able to open every database on the host. A
  fresh Postgres grants `CONNECT` to `PUBLIC`, so the operator runs the statement the platform
  prints at startup (ADR-026), and `GET /health/posture` reports whether it was done:

```sql
REVOKE CONNECT ON DATABASE "<odoo-db>" FROM PUBLIC;
GRANT CONNECT ON DATABASE "<odoo-db>" TO odoo;
```

- Validation (optional) runs against a **scratch database** with a name the platform generated,
  never a copy of a client's data (ADR-027).

### 2.5 Connected-server replica and the standard database catalog

When the customer's Odoo is on **another server**, the in-place mode of §4.4 cannot
reach it. The estate is then replicated on the Cartenz host (ADR-050):

| Part | Source | Client data? |
| --- | --- | --- |
| Addons code | The project's Git repository, cloned per task | No |
| Database | LinkedERP's **standard database** for the version + edition + region (ADR-051) | No |
| Odoo source | The shared read-only checkout for the project's version (ADR-045) | No |

This is what makes a UI preview possible before deploy: the replica is a real, runnable
Odoo the agent and a reviewer can see. The customer's database is never cloned — a
client example database is a separate, manual, explicit restore.

**Standard database catalog.** `database/` holds LinkedERP's own baselines, one per
edition + region + Odoo version, catalogued in `database/manifest.json`, and committed
with git. The zip is restored **once** into a host template
`cartenz_tpl_<version>_<edition>_<region>`; project databases are fast clones of that
template (ADR-045). A full restore from the catalog applies to Cartenz-hosted instances
(preview, validation, replica); an external Odoo.sh instance builds its own database,
so there the catalog is used for local preview/validation only.

**Deploy target.** The hosted replica and the customer instance are distinct. The
replica deploys with the local `pull-project.sh` (ADR-049). The customer instance —
possibly on another host — **pulls the branch itself** (webhook, CI or scheduled
`git pull`); Cartenz's job ends at pushing to the customer's GitHub repository. Cartenz
does not deploy to that host and holds no SSH path to it (ADR-050).

---

## 3. Creation lifecycle

What happens, in order, when a project is created through Cartenz:

1. **Project row and environments** are written in one transaction, so a project without an
   environment cannot exist (ADR-034).
2. **Scaffold** (for `ai_project` / scaffolded `on_premise`): the addons directory, `odoo.conf`,
   `run.sh`, `.gitignore`, `README.md`; Git initialised on `main`, first commit, then
   `staging` and `development` branches. Branch creation is atomic — a failure tears the whole
   scaffold down (ADR-032, ADR-035, ADR-038).
3. **Source paths** resolve through the version catalog for the declared version, falling back
   to the deployment-wide Odoo paths when no catalog row is active (ADR-045).
4. **Provisioning** (optional, `PROJECT_PROVISIONING_ENABLED`): the operator's `create_project`
   scripts run behind `sudo`, with a sudoers `Cmnd_Alias` and `assertProvisioningInvocation`
   as two independent gates (ADR-039). The database is cloned from the template.
5. **HTTPS** (optional): `certbot --nginx` for the project's own domain, refusing any domain
   that is not already that project's Nginx `server_name` (ADR-040).
6. **GitHub repository** (optional, `GITHUB_REPOSITORY_ENABLED` + `GIT_PUSH_ENABLED`): the
   repository is created, `origin` set, the credential sealed, and every branch pushed
   (ADR-041). A failure here is logged and reported but does not fail the project.

Every step after the project row is **best-effort and reported**, because a project that exists
without a certificate or a remote is still a usable project, and a failed creation is not.

---

## 4. Maintenance and operations

### 4.1 Access rights (three layers)

Access is decided in three layers, and a person must pass all three (ADR-043, ADR-044):

| Layer | What it decides |
| --- | --- |
| **Region** | Which projects a person sees by default. A project and a user each carry a region; an admin sees every region. |
| **Per-project grant** | Admits a named person to a single project across the region boundary. A locked project is listed but redacted, opening it is **403**, and a request-and-approve flow records the ask. |
| **Rank** | `users.is_admin` decides who may manage settings, users and provisioning. There is no rank between "admin" and "everyone else". |

Enforcement lives in `AuthorizationService.requireProjectAccess`, the single point every
project-scoped call site already passes through, so a forgotten call site cannot be a silent
hole. A grant carries access and nothing else — what a person may *do* inside a project stays
governed by their rank and the project's own `agentPermissions`.

> **Status: implemented and verified.** `infrastructure/scripts/smoke-test-access.sh` exercises
> 24 checks on the development host: redacted listing, 403 on open, a request created and
> deduplicated, the admin queue, approval making the same request 200, the panel reporting the
> access as revocable, and a revoke returning the 403. See §6.

### 4.2 Independent backup and restore (target)

A client's estate must be restorable **without the platform**. Cartenz creates and changes a
client's Odoo, which is precisely why it must not be the only thing that can bring one back: a
backup readable only by the system that failed is not a backup.

Target design, per client, covering three things together:

| Piece | Source | Notes |
| --- | --- | --- |
| Database | `pg_dump <client_db>` | Compressed; per-client, not one estate-wide dump |
| Filestore | `<project>/data/` (attachments, generated documents) | Must travel with the database or attachments break |
| Addons repository | `<project>/addons/` | It is a Git repository; the remote is the primary copy, but a snapshot is retained |

Requirements that shape it:

- **A backup is taken automatically before a change reaches a staging or main database**, so a
  promotion always has an immediately preceding restore point and rolling back is a restore
  rather than a repair.
- **Retention is held separately from the instance**, so losing the host does not lose the
  backups.
- **The restore path is usable by an operator with server access and no platform access**, so
  custody of the backup and custody of the platform are separable — which is what makes a
  client's estate transferable at the end of an engagement.
- **The restore is periodically exercised**, not assumed.

> **Status: not implemented.** No backup, retention or restore machinery exists in the platform
> today. The only documented backup is the platform's own (`docs/guides/server-setup-from-scratch.md`
> §9) and the one-time migration dump. See §6 for the next step.

### 4.3 Connection between the platform and a linked hosted server

The platform reaches a linked hosted server **only** through two root-run scripts, each behind
two independent gates (a sudoers `Cmnd_Alias` naming exact absolute paths, and a re-validation
in `CommandRunner` before a process is built):

| Action | Script | Gate | Records |
| --- | --- | --- | --- |
| Create/repair an instance | `create_project` / `create_project_enterprise` | `PROJECT_PROVISIONING_ENABLED` | creation response |
| Issue HTTPS | `setup-project-https.sh` | `PROJECT_HTTPS_ENABLED` | certificate status on the project |
| Deploy a branch onto the instance | `pull-project.sh` | `PROJECT_PULL_SCRIPT` set | `project.pulled` / `project.pull_failed` |

`pull-project.sh` runs `git fetch` then `reset --hard` to the branch tip **as the `odoo` user**,
because the project directory is `odoo:odoo` 750 and a root-run `git` would leave root-owned
objects. The credential travels on stdin through a mode-0700 `GIT_ASKPASS` helper, never in
`argv`, so it cannot be read from `/proc/<pid>/cmdline` (ADR-049).

There is **no inbound connection from the server to the platform**: the pull is a person's
action in the portal, not a webhook. A webhook is a later option that can layer on the same
script without changing anything below it.

### 4.4 On-premise (connected) server: administration plan

For a linked hosted server, the ordinary administration of the host is LinkedERP's. For a
connected server it is the customer's. The platform's own contribution is to expose what it
alone knows, so an administrator sees the estate and the platform's posture in one place.

**What the platform already exposes:**

- `GET /health/ready` — Postgres and Redis up.
- `GET /health/posture` — whether push is enabled, whether the database is isolated, whether the
  AI data boundary applies to every model call, and which databases the platform's role can reach.
- Per-project instance panel — URL, database, HTTPS status, `hasMasterPassword`, and Deploy.

**What a linked hosted server still needs (operational, not architectural):**

| Task | Cadence | Tooling | Status |
| --- | --- | --- | --- |
| OS security updates | Stated cadence (e.g. weekly) | `unattended-upgrades` for security pocket; reboot window | Not set up |
| Odoo security updates | Per Odoo release | Update the shared read-only checkout per version, then restart each instance on that version | Not set up |
| Certificate renewal | Automatic | `certbot` timer | Depends on `PROJECT_HTTPS_ENABLED`; no timer verified |
| Disk monitoring | Continuous | Node exporter + alert on the projects root and Postgres volume | Not set up |
| Service monitoring per instance | Continuous | systemd + a check that each `odoo-*` unit is active and answering | Not set up |
| Log retention | Rolling | `logrotate` exists for the platform; per-instance Odoo logs need a rule | Partial |
| On-call route for failures | Continuous | Alert delivery (email/chat) | Not set up |
| Administration dashboard + notification | Continuous | A portal surface for the estate plus a notification route | Not set up |

**Security baseline for an on-premise host** (already stated in
`docs/guides/server-setup-from-scratch.md` §10 and repeated here because it is the plan):

- `.env` mode 600 owned by `cartenz`; `SECRETS_ROOT_KEY` backed up off the server.
- Postgres, Redis, gateway and Hermes bound to loopback only; only 443 and SSH open.
- Services run as `cartenz`, never root; Odoo runs as `odoo`.
- `GIT_PUSH_ENABLED`, `GITHUB_REPOSITORY_ENABLED`, `PROJECT_PROVISIONING_ENABLED` and
  `VALIDATION_ENABLED` are off by default and refused at the process layer.
- `cartenz` can read the Odoo base/enterprise source but owns neither; validation uses a
  dedicated `CREATEDB` role, never the Odoo superuser.
- The platform's role cannot open every customer database (`REVOKE CONNECT ... FROM PUBLIC`).

---

## 5. Development architecture

### 5.1 Repository layout

| Layer | Location | Notes |
| --- | --- | --- |
| Platform code | The Cartenz monorepo (`backend/`, `frontend/`, `infrastructure/`) | One deployment-wide repository; not per client |
| Client code | One GitHub repository per project, the addons tree | Created at project creation (ADR-041) |
| Odoo source | One shared read-only checkout per version, catalogued (ADR-045) | Never copied per client |
| Task workspace | `/tmp` (clone-backed modes), destroyed with the run | On-premise works in place instead |

### 5.2 Branch policy

- `development` and `staging` are targetable; `main` is not. Production is refused at task
  creation and when moving the default (ADR-021).
- A task works on **the branch a person chose**, not a branch of its own (ADR-046). The
  workspace clones the environment's branch and stops; the push follows it. `main` keeps a
  branch of its own because the platform never works or pushes to it.
- Routine non-production pushes may be auto-approved with `GIT_AUTO_PUSH_ON_TASK=true`; each is
  audited as `task.push_auto_approved`. Production remains unreachable either way.

### 5.3 What a task is allowed to do

- **Read** the repository and the shared Odoo source freely.
- **Write** only into the project's own addons directory, and only after approval
  (`chat_edit` in a chat task, the plan gate in a change task).
- **Commit** only after review; `git_commit` / `git_push` / `git_branch` are not offered to the
  model (`availableToModel: false`).
- **Never** execute arbitrary shell; no database export or backup tool exists.

---

## 6. Operator request register

The operator's list, item by item, with the honest status as of 17 September 2026.

### 6.1 Centralised Odoo version repository per new installation

> *"Setiap installation baru, Cartenz akan menggunakan full set of coding dari Odoo tergantung
> versi yg dipilih. Tujuannya agar kita punya 1 centralized version dan tidak perlu menggunakan
> AI token untuk creation setiap ada request."*

**Status: Implemented** (ADR-045).

- `odoo_version_repositories` (migration 0016) holds one row per Odoo series — base checkout,
  enterprise addons path, active flag.
- A project's declared version resolves its source through the catalog; a version with no active
  row falls back to the deployment-wide Odoo paths.
- Template databases, one per version and edition, are built once with every app installed;
  a new project's database is cloned in seconds.
- **No model tokens are spent** producing what already exists on disk.

**Operator step still required:** build the templates with
`infrastructure/provisioning/build-odoo-templates.sh` and update the operator's own
`create_project` scripts to accept the optional version argument and call
`create-project-db.sh` (`docs/guides/odoo-version-templates.md`).

### 6.2 Server and development architecture per client

> *"Buat server architecture dan development architecture: untuk create structure database per
> client di GitHub maupun di Hosting server. Untuk menghandle system creation dan maintenance
> ke depan dari sisi security, access right, independent backup process/restore."*

**Status: architecture documented in §2–§5; partially implemented.**

| Capability | Status | Next step |
| --- | --- | --- |
| Per-client estate on a hosting server (directory, db, service, site, port, sealed master password) | Implemented | — |
| Centralised Odoo source per version | Implemented | Build templates on the host |
| Template databases, full install | Implemented | Operator builds them once |
| Per-client GitHub repository with a branch per environment | Implemented | — |
| Region scoping and per-project access grants | Implemented | See §6.9 |
| Certificate issuance per client domain | Implemented | Install the `certbot` timer |
| **Repo-backed connected projects** (remote on-premise replica) | **Implemented** (ADR-050) | Host that predates the change must update its create scripts by hand |
| **Standard database catalog** (edition + region + version) | **Implemented** (ADR-051); artifacts pending | Upload the zip archives; build the region templates on the host |
| **Independent backup and restore** | **Not implemented** | Build the per-client backup/retention/restore in §4.2 |
| **Backup triggered before a staging/main change** | **Not implemented** | Depends on backup above; hook into `commit()`/push path |
| **Monitoring, admin dashboard and notification** | **Not implemented** | See §4.4 and §6.3 |

### 6.3 Linked on-premise server: security updates, monitoring, server admin

> *"For Linked On premise server, need to plan the security update, monitoring tools, and all
> other server administration task."*

**Status: planned in §4.4; not implemented.**

What exists: `health/ready`, `health/posture`, the per-project instance panel, and the Deploy
action. What is missing: OS/Odoo patching cadence, disk and service monitoring, per-instance
log retention, alerting, and an administration dashboard with notifications.

**Next step:** adopt the table in §4.4 as the runbook, starting with the cheapest controls
that give the most signal — `unattended-upgrades` for the security pocket, a disk alert on the
projects root, and a per-instance systemd/HTTP check. The dashboard and notification route are
the same gap named for the access-request queue (ADR-043) and should be built once, not twice.

### 6.4 Backup triggered while pushing to staging/main

> *"Find a way to trigger backup while pushing new changes onto Staging/Main database."*

**Status: Not implemented.** It depends on §4.2.

The correct hook point is the platform's push path, where the target environment's kind is
already known: a push that targets a `staging` environment (and any future promotion to a
production-representing branch) should take a per-client snapshot of database + filestore +
addons **before** the remote is updated, and record the restore point on the task. A push that
fails its backup should not proceed.

**Next step:** build §4.2 first, then add one guarded step in `commit()` / `push()` in
`backend/src/agent/orchestration/agent-workflow.ts` and an audited `backup` event.

### 6.5 Code changes in Chat / Change code

> *"Fix the functionality to do code changes in the Chat/Change cod of the project in Cartenz."*

**Status: the `change` flow works; a code change made in `chat` is written but never committed
or pushed.**

- `change`: plan → approval → implement → validate → commit → push. Correct.
- `chat`: the model may call a write tool, which pauses the task for the `chat_edit` approval.
  Once approved, the file is written, the diff is computed and retained on the task — but the
  workspace is destroyed and **no commit or push happens** (`agent-workflow.ts:941`,
  `model-chat-loop.ts:271`: "Do not commit or push. A chat never does."). The change is visible
  as a diff and then lost.

ADR-047 fixed how a conversation *reads* (sessions and threads). It did not change this: a chat
edit is reviewable but not landable.

**Next step (a decision before code):** choose one of
1. let an approved chat write continue into the normal commit/push path, so a conversational
   change can land; or
2. keep chat read-only and add an explicit **"Turn this into a change task"** action that
   re-runs the described change through the `change` flow.
Option 2 is the smaller blast radius and preserves the current meaning of `chat`; option 1 is
what most users will expect. This needs an ADR.

### 6.6 Data exposed to an outside LLM

> *"How data being exposed to outside LLM (to consider Data breach issue)."*

**Status: a structural boundary is implemented (ADR-020); two deliberate gaps remain.**

What is enforced, in code rather than policy:

- **One chokepoint.** `GuardedModelProvider` wraps every provider and is the only thing bound to
  the token; the unguarded providers are not exported. There is no path to a model that skips it.
- **Three filters, both directions.** Sensitive-data (refuses pg_dump, INSERT batches, customer
  CSV, JSON record arrays), secret scanner (nine credential formats, PEM, URL passwords —
  redacts, and refuses a secrets file), and PII (email, Luhn-valid cards, SA identity numbers,
  telephone numbers — redacts).
- **Tool results are filtered too**, because `read_file` is the one place the platform hands
  over content it has never inspected. A refused result is withheld from the model, not acted on.
- **Every model call is accounted** in `agent_model_calls` (provider, tokens, steps,
  redactions), and `health/posture` reports that the boundary applies to every call.
- A **local gateway (9router) or a local Hermes agent** can be the only provider, in which case
  nothing leaves the host at all.

Gaps, stated honestly:

1. **Source code itself is sent to the provider by design** (chapter 12 permits source, module
   structure, error messages and sanitised logs). The boundary removes customer *data*, not the
   customer's *code*. A deployment that must not send code off-host has to use a local model
   behind the gateway.
2. **Image bytes bypass the text boundary by design** (ADR-042, point 5). A pasted screenshot is
   treated as the operator's own input, so a secret in a screenshot is sent. Documented, and the
   retirement condition is recorded in the ADR.

**Next step:** document a one-page data-processing posture per deployment (which provider, in
which jurisdiction, what is sent), and add an explicit per-project "local provider only" flag
for clients who will not accept off-host egress. Revisit image handling if the platform gains a
binary-aware boundary.

### 6.7 Paste an image/photo/file in the chat

> *"To also include the feature to paste the image/photo/file instead of doing the upload
> document in the chat."*

**Status: Implemented for images; documents remain upload-only.**

- **Image paste is implemented** (ADR-042). The chat composer handles `onPaste`
  (`frontend/app/projects/[projectId]/agent/page.tsx:350`), stores the image as base64 in
  `project_documents.image_data_base64` (migration 0013), and sends it as a structured image
  content block to a multimodal model. Caps: 5 MiB per image; `image/png`, `image/jpeg`,
  `image/webp`, `image/gif`.
- **File upload is implemented** (ADR-030): Markdown, text, PDF and DOCX via the upload button.
- **Pasting a non-image file** (e.g. a PDF from the clipboard) is not handled; the paste handler
  looks only for an image item.

**Next step:** extend the paste handler to accept non-image clipboard files through the same
`POST /projects/:id/documents` path, so the distinction between "paste" and "upload" disappears.

### 6.8 UI preview before approving/deploying

> *"To add the preview that include UI presentation to ensure the user get the complete draft
> before approving and deploying it onto Odoo."*

**Status: Not implemented.**

What exists is a **code** review, not a UI preview: `DiffViewer` shows the per-file patch with
line numbers, and `ApprovalPanel` names the action being authorised. There is no rendered
Odoo screen, no draft instance, and no way to see the change as a user of the Odoo would.

**Next step (a real design decision):** the options, cheapest first —
1. **Static render** of changed views/XML into a component preview (no Odoo), enough for field
   and form changes but not behaviour;
2. **Ephemeral preview instance** — provision a scratch copy of the project's database, install
   the branch's modules, expose a short-lived URL for the reviewer, then tear it down. This is
   the honest preview and it is the expensive one; it leans on the same template-database
   machinery as ADR-045 and the validation runner of ADR-027. **ADR-050's connected-server
   replica already produces exactly this** (code from Git + standard database + Odoo source),
   so building the replica and building the preview are the same work. **ADR-052 (Proposed)
   specifies it in full.**
3. **Deploy-to-staging preview** — use the existing `pull-project.sh` against a staging instance
   and present the staging URL as the preview.
This needs an ADR, because it changes what "approve" means and what resources a draft costs.
ADR-052 is that ADR, and it turns on one fact: the task workspace is destroyed the moment a run
suspends for an approval, so a preview is rebuilt from the task's retained diff rather than from
a live workspace.

### 6.9 Access Right on the portal

> *"Access Right set on the portal to be completed. Check if there's done or not."*

**Status: Implemented and verified — no further work required for the stated scope.**

| Piece | Where | State |
| --- | --- | --- |
| Region scoping | `users.region`, `projects.region`; list filters by region | Done |
| Admin flag | `users.is_admin`; governs settings, users, provisioning | Done |
| Per-project grant | `project_members`; grant/revoke endpoints | Done |
| Request-and-approve | `project_access_requests`; pending unique index; admin queue | Done |
| Locked project in the list | Listed with `description`, `repositoryUrl`, task counts withheld; `hasAccess: false` | Done |
| Opening without access | **403**, not 404 | Done |
| Portal surfaces | Locked project cards, request button, owner grant panel, admin request panel | Done |
| Enforcement point | `AuthorizationService.requireProjectAccess` (one decision point) | Done |
| Verification | `infrastructure/scripts/smoke-test-access.sh` — 24 checks passing on the dev host | Done |

**Known, deliberate gaps (not defects):**

- **No notifications.** A pending request sits in the admin queue with a count; nothing pushes a
  notice. This is the same dashboard/notification gap as §6.3 and should be built once.
- **A grant carries access only**, not a per-project role. Depth stays governed by
  `users.is_admin` and the project's `agentPermissions`. Adding a per-project role would create
  a second permission model to keep in step with the first.
- **`smoke-test.sh` is broken** against the region model (it still posts `organizationName`);
  `smoke-test-access.sh` is the one to run. Rewriting `smoke-test.sh` is outstanding.

---

## 7. Summary status table

| # | Requested capability | Status | Next step |
| --- | --- | --- | --- |
| 1 | Centralised Odoo version repo, full code per version, no AI tokens | **Done** (ADR-045) | Build templates; update operator scripts |
| 2 | Server + development architecture per client (GitHub + hosting) | **Documented; mostly built** | Remote replica + standard DB catalog now implemented (ADR-050, ADR-051); remaining: upload DBs + build templates, backup/restore, monitoring (§6.2) |
| 3 | On-premise security updates, monitoring, server admin | **Not done** | Adopt §4.4 runbook |
| 4 | Backup on push to staging/main | **Not done** | Build §4.2, then hook the push path |
| 5 | Fix code changes in Chat/Change | **`change` done; `chat` writes but never lands** | Choose option 1 or 2 in §6.5 (ADR) |
| 6 | Data exposure to outside LLM | **Boundary done** (ADR-020); two documented gaps | Data-processing posture; local-only flag |
| 7 | Paste image/photo/file in chat | **Images done** (ADR-042); files upload-only | Accept non-image paste |
| 8 | UI preview before approve/deploy | **Proposed** (ADR-052) | Build the ephemeral preview instance (§6.8 option 2); depends on the ADR-050 replica |
| 9 | Access Right on the portal | **Done and verified** (ADR-043/044) | Notifications, shared with §6.3 |

---

## 8. References

| Topic | Document |
| --- | --- |
| Full architecture | `docs/reference/LinkedERP_AIDevAgent_TechArchitecture_v1.7_2026-09-16_1.docx` §18 |
| Implementation state | `docs/implementation-status.md` |
| Odoo version catalog and templates | `docs/guides/odoo-version-templates.md`, ADR-045 |
| Creating and running projects | `docs/guides/creating-and-running-projects.md` |
| Server setup | `docs/guides/server-setup-from-scratch.md`, `docs/INSTALL-SERVER.md` |
| Provisioning, HTTPS, deploy | ADR-039, ADR-040, ADR-049 |
| Connected-server replica and remote deploy target | ADR-050 |
| Standard database catalog (`database/`) | ADR-051, `database/README.md` |
| UI preview before approve/deploy | ADR-052 (Proposed) |
| Access control | ADR-043, ADR-044 |
| AI data boundary | ADR-020, ADR-042 |
| Push safety and branches | ADR-021, ADR-041, ADR-046 |
