# LinkedERP AI Development Agent

An AI-assisted development platform for Odoo projects. A user connects or creates a
project, describes a change in plain language, and an agent analyses the project,
produces an implementation plan, and — after human approval — modifies the code,
validates it, commits and pushes.

The governing architecture is held in `docs/reference/`:

1. `LinkedERP_AIDevAgent_TechArchitecture_v1.5_2026-09-16_1.docx`
2. `LinkedERP_AIDevAgent_FrameworkSelection_v1.0_2026-08-27_1.docx`

Those documents are authoritative. Implementation decisions that deviate from
them, or that resolve a conflict within them, are recorded in `docs/adr/`
(ADR-011 onward).

**Status: Phases 1–3 complete; Phase 4 (validation) and Phase 5 (Git automation and
Odoo-aware delivery) delivered.** The agent is model-driven and has been run against
a real model. It works a project in one of three execution modes, asks a model for a
plan, carries that plan out through a tool loop after a person approves it, produces
a real `git diff` for review, makes a real commit, runs a real Odoo test run where a
runtime is configured, and pushes to a real remote.

The platform can also **create** a project rather than only connect to one: scaffold
its module layout, provision a running Odoo instance behind HTTPS, and give it a
GitHub repository its pushes land in.

---

## 1. What the agent runs on: three execution modes

A project type records where a project came from; an execution mode records how a
task on it actually operates (ADR-028). One place decides the mapping, so no tool,
workflow or validator answers the question twice.

| Mode | The agent works on | Git | Filesystem |
| --- | --- | --- | --- |
| `odoo_sh` | A Cartenz-managed per-task clone, destroyed with the run | Managed by the platform; pushes to the remote | Workspace only |
| `on_premise` | The selected local directory, **in place** — no clone | The directory's own repository | The directory, with shared base and enterprise trees read-only |
| `odoo_online` | The Odoo instance through Studio | None | None |

`repository` and `odoo_sh` project types share the `odoo_sh` mode. An `ai_project`
has no mode until it has been given a local directory, after which it runs
on-premise like any other local project (ADR-036).

On-premise operating in place, rather than through a clone, is the decision that
makes the agent useful on a host that already runs the customer's Odoo — and it is
why path containment, not workspace disposal, is what bounds it there.

---

## 2. Architecture at a glance

| Layer | Technology |
| --- | --- |
| Portal | Next.js 15, React 19, TypeScript, Tailwind CSS |
| API and worker | NestJS 10, TypeScript |
| Database | PostgreSQL, Drizzle ORM, Drizzle Kit migrations |
| Queue and realtime | Redis, BullMQ, WebSocket |
| Model | Vercel AI SDK 6 behind `ModelProvider`; hosted, self-hosted or scripted (ADR-020) |
| Model configuration | Per organisation, set in the portal; token sealed, never returned (ADR-023) |
| AI egress | One chokepoint, three filters, applied in both directions (ADR-020) |
| Orchestration | Explicit tool loop behind `AgentOrchestrator` (Temporal is the target, ADR-011) |
| Execution modes | Three adapters, one mapping from project type (ADR-028) |
| Process execution | One chokepoint, argument vectors only, never a shell (ADR-019). `git`, `python3` and `sudo` only — the last two refused unless their setting is on |
| Target environments | A project declares its branches; production is not targetable (ADR-021) |
| Workspaces | A per-task clone for `odoo_sh`; the selected directory in place for `on_premise` |
| Code understanding | Candidates ranked by what they declare, not by text match (ADR-025) |
| Repository writes | `edit_file` replaces one quoted region; whole-file rewrites are bounded (ADR-022) |
| Validation | A real Odoo test run in a scratch database, where a runtime is configured (ADR-027) |
| Project creation | Scaffold, provision a running instance, issue HTTPS (ADR-032/036/039/040) |
| Remote | A created project gets a GitHub repository its pushes land in (ADR-041) |
| Secrets | Envelope encryption behind `SecretsProvider` (Vault is the target, ADR-014) |
| Identity | First-party JWT behind `JwtAuthGuard` (Keycloak or Ory is the target, ADR-015) |
| On-premise posture | Reports which databases its own credentials can reach (ADR-026) |

Two guiding principles run through the code:

1. **The AI can request actions; the platform controls execution.** Every agent
   action is a tool request that passes through a permission validator, a policy
   check and — where required — a human approval, before anything executes. The
   gate is `backend/src/agent/tools/permission-validator.ts`, and there is no
   second path.
2. **The agent is code-aware but data-blind by default.** Production database
   record access is denied by default. Export and backup are not settable at all.
   Nothing outside `backend/src/core/secrets/` holds a plaintext credential, and
   every audit, action and event payload passes through
   `backend/src/core/audit/redact.ts`.

**Everything sent to a provider, and everything received, passes the AI data
boundary first** (chapter 12, ADR-020). That is not configurable.

---

## 3. The safety properties, and where each is enforced

Each of these is a property of the system rather than of a tool's implementation:
it holds regardless of which code path asked, whether a permission was granted, or
whether an approval was recorded.

**Pushing.** `git push` is refused by the process layer before a process is built
unless `GIT_PUSH_ENABLED=true` (ADR-021). Not the tool — the process layer. With it
enabled, a push still needs the `git_push` approval, except for routine
`development`/`staging` work where `GIT_AUTO_PUSH_ON_TASK=true` opens it and audits
each one (ADR-041).

**Production.** A task pointed at a `production` environment is refused before any
row is written, and the refusal is in the audit trail. Neither Odoo.sh nor
on-premise work is ever done on `main` (ADR-021, ADR-028). This is a closed door,
not an approval gate.

**Running code.** `python3` is refused unless `VALIDATION_ENABLED=true`, and even
then only an `odoo-bin` inside a configured runtime may start — not a bare
interpreter, not `-c`, not `-m`, not another script, and not a look-alike directory
(ADR-027).

**Privilege.** `sudo` is refused unless `PROJECT_PROVISIONING_ENABLED=true`, and is
narrowed to a fixed set of operator script invocations by two independent gates: a
sudoers `Cmnd_Alias` with no wildcards, and an argument-shape check in
`CommandRunner`. Neither is trusted alone (ADR-039).

**Writes.** Every path is resolved through `realpath` before use, so a symlink
cannot reach outside the workspace or, on-premise, outside the selected directory.
Shared base and enterprise trees are mounted read-only (ADR-028, ADR-031).

**Secrets.** A credential is sealed on arrival and returned by no endpoint — the
response shapes have no field that could carry one. The one exception is a
provisioned instance's master password, revealed only by its own audited,
owner-restricted endpoint (ADR-040).

There is no shell tool of any kind, and the tool registry is tested to assert that
none exists.

---

## 4. Repository layout

```
.
├── backend/            NestJS API and agent worker (one build, two entry points)
│   ├── drizzle/        Generated migrations (13)
│   └── src/
│       ├── agent/
│       │   ├── analysis/       Odoo manifest parsing, code search, model index, project memory
│       │   ├── executors/      The three execution modes (ADR-028)
│       │   ├── git/            Git service, URL validation, credential lease
│       │   ├── model/          Provider bindings and the guarded provider
│       │   ├── orchestration/  Workflow, planner, queue orchestrator
│       │   ├── tools/          Registry, permission validator, real and simulated tools
│       │   ├── validation/     Odoo runtime registry, scratch databases, test runner (ADR-027)
│       │   └── workspace/      Workspace manager and path containment
│       ├── core/       Config, database, redis, process, secrets, authz, audit, ai-boundary, events
│       └── modules/    auth, organizations, projects, tasks, approvals, realtime, health
├── frontend/           Next.js portal
├── connector/          Python on-premise connector (Phase 6, not started)
├── infrastructure/
│   ├── compose/        docker-compose.yml
│   ├── docker/         Dockerfiles
│   ├── provisioning/   Sudoers rule and operator scripts (ADR-039, ADR-040)
│   ├── proxy/          Nginx configuration
│   └── scripts/        Local runtime, installers and verification scripts
└── docs/
    ├── adr/            Architecture decision records (ADR-011 … ADR-041)
    ├── guides/         Creating and running projects; server setup
    ├── reference/      The approved architecture documents
    ├── implementation-status.md
    └── verification-log.md
```

---

## 5. Running the stack

Step-by-step local instructions are in **[RUNNING.md](RUNNING.md)**. To stand the
platform up on a server, see **[docs/INSTALL-SERVER.md](docs/INSTALL-SERVER.md)**,
or **[docs/INSTALL-SERVER-EXISTING-ODOO.md](docs/INSTALL-SERVER-EXISTING-ODOO.md)**
for a host that already runs Odoo. A summary follows.

### 5.1 With Docker

Requires Docker with Compose v2. Copy `.env.example` to `.env`, set `JWT_SECRET`
and `SECRETS_ROOT_KEY` (each `openssl rand -hex 32`) and `POSTGRES_PASSWORD`, then:

```bash
docker compose -f infrastructure/compose/docker-compose.yml up -d --build
```

The portal is then on `http://localhost:8080`, behind the reverse proxy that also
serves the API and the WebSocket.

This path is authored but has **not** been executed on the development host, which
has no container runtime. See ADR-012.

### 5.2 Without Docker (the verified path)

Requires Node.js 20+, a reachable PostgreSQL, a C toolchain and network access.
No root privilege is needed; Redis is built into `~/.local`.

```bash
./infrastructure/scripts/bootstrap-env.sh
```

```bash
./infrastructure/scripts/dev-up.sh
```

`bootstrap-env.sh` generates `.env` with fresh secrets; set `DATABASE_URL` in it to
your PostgreSQL instance before `dev-up.sh` builds, migrates and starts everything.

| Service | Address |
| --- | --- |
| Portal | http://localhost:3000 |
| API | http://localhost:4000/api/v1 |
| Readiness | http://localhost:4000/api/v1/health/ready |
| Posture | http://localhost:4000/api/v1/health/posture |

Logs are written to `.runtime/*.log`. Stop with
`./infrastructure/scripts/dev-down.sh`.

---

## 6. Verification

One command runs everything and fails if anything fails:

```bash
./infrastructure/scripts/verify-all.sh
```

Add `--fast` to skip the smoke suites. This script exists because an aggregate that
swallows exit codes is worse than none: a run of the full suite once reported
success while 107 checks were failing, because the loop that ran them discarded each
result. A smoke suite that could not run because the stack was down is counted as a
**failure**, not skipped — a suite that did not run has not passed, and reporting it
beside a green total is how a broken build looks healthy.

The individual commands, when you want one of them:

```bash
npm run typecheck                                       # backend and frontend
npm test                                                # 631 unit tests, 53 suites
./infrastructure/scripts/smoke-test.sh                  # API and workflow
./infrastructure/scripts/smoke-test-repository.sh       # repository agent
./infrastructure/scripts/smoke-test-agent.sh            # model layer and AI boundary
./infrastructure/scripts/smoke-test-safety.sh           # push refusal and environments
./infrastructure/scripts/smoke-test-deletion.sh         # archive, restore, permanent delete
./infrastructure/scripts/smoke-test-validation.sh       # a real Odoo run, where one is configured
node infrastructure/scripts/probe-push-refusal.js       # the compiled runner, asked to push
node infrastructure/scripts/probe-validation-refusal.js # the compiled runner, asked to run Python
node infrastructure/scripts/probe-write-containment.js  # the write tools, aimed outside the workspace
node infrastructure/scripts/probe-github-posture.js     # the GitHub repository posture
./infrastructure/scripts/verify-portal-safety.sh        # the portal's safety surfaces
./infrastructure/scripts/verify-portal-settings.sh      # the provider configuration screen
./infrastructure/scripts/verify-portal-deletion.sh      # the project removal surfaces
```

To get a project you can sign into and click around:

```bash
./infrastructure/scripts/seed-demo-project.sh
```

It creates an account and a project — by default the `LinkedERP/Odoo` repository on
`StagingDM`, with `main` declared as production and therefore not targetable — and
prints the sign-in details once, to that terminal only. Override with `EMAIL`,
`PASSWORD`, `REPOSITORY_URL`, `BRANCH` and `ODOO_VERSION`. Re-running it with the
same email adds another project rather than failing.

What each suite is for:

- **`smoke-test.sh`** exercises the documented workflow through the HTTP API only,
  and asserts the security properties: organisation isolation, that a credential
  never appears in a response or the audit trail, and that database export cannot
  be granted.
- **`smoke-test-repository.sh`** covers Phase 2: that the clone, the analysis, the
  diff and the commit are real, that generated XML is well formed, that workspaces
  are destroyed, and that five hostile repository URLs are refused. Its **§10b** is
  the regression test for ADR-022: a 16 KB fixture file, eight times the audit
  filter's string limit, must survive a read-write round trip with its last line
  intact **and must actually have been modified**. The second half matters —
  without it the check passes when the write is refused and the file skipped, which
  is a guard working rather than a round trip working. This test was confirmed to
  fail with the root cause reintroduced; a test that has not been seen to fail is
  not yet a test.
- **`smoke-test-agent.sh`** covers Phase 3: that the plan records what produced it,
  that every model call is accounted for, that the boundary removes a planted
  credential before it leaves the platform, that a redacted value is never written
  back into the repository, and that the model is not offered `git_commit`,
  `git_push` or the validation tools.
- **`smoke-test-safety.sh`** covers ADR-021: that a task cannot target production
  and leaves no row when it tries, that the default target cannot be moved to
  production, that both refusals are audited with the branch named, that the branch
  actually cloned is the environment's and not the project default, and that with
  pushing disabled no push approval is requested. Run it in both push
  configurations — it reads `git.pushEnabled` from the server and asserts the
  behaviour that configuration should have, so a guarantee is never tested in only
  one of them.
- **`smoke-test-deletion.sh`** covers ADR-024: that archiving destroys nothing and
  can be undone, that an archived project can still be read but will not accept a
  task, a connection, an environment or a permission change, that a permanent
  delete needs the project's name typed back and refuses while a task is
  unfinished, and — the reason the file exists — that a delete destroys the
  project's sealed credentials rather than leaving them encrypted in the database,
  owned by nothing. `secret_records.project_id` carries no foreign key by design,
  so nothing in the database would have removed them.
- **`smoke-test-validation.sh`** covers ADR-027 and needs a host with Odoo on it:
  that the platform's credentials reach no customer database, that the validation
  role can create databases and is not a superuser, that a task's results are real
  rather than simulated, that no scratch database is left behind, and that the
  generated Odoo configuration never appears in the diff a person is asked to
  approve. It reports which of those is missing rather than failing obscurely.

The two repository suites need a repository to clone, so they create a local
fixture on first run (`create-test-repository.sh`) and reach it through a `file://`
remote — which requires `GIT_ALLOW_LOCAL_REMOTES=true`, a setting refused in
production.

The unit tests are written to assert refusal rather than success: a path-containment
test that only checked the happy case would pass against an implementation that
checks nothing. Results are recorded in `docs/verification-log.md`.

---

## 7. The workflow

```
Connect or create project
  → Submit prompt            POST /api/v1/projects/{id}/tasks
  → ANALYZING                real clone or in-place directory, Odoo detection, code search
  → PLANNING                 a model call, through the AI data boundary
  → WAITING_APPROVAL         the plan is put to a person
  → IMPLEMENTING             a tool loop the model drives, every call mediated
  → TESTING                  a real Odoo run where a runtime is configured; simulated
                             and stated as such where one is not
  → COMMITTING               real commit on the AI branch
  → WAITING_APPROVAL         the push is put to a person (auto-approved for
                             development/staging when enabled)
  → PUSHING                  real push to the connected remote
  → COMPLETED                workspace released
```

Branches follow `ai/task-{task_id}-{short-description}`. The agent never commits to
the default branch, and never works `main`.

A task may also be **conversational** (ADR-029): a question about the project that
changes nothing and therefore needs no approval.

---

## 8. Environment

`.env.example` is the contract and documents every variable. Two values have no
default and the API refuses to start without them:

| Variable | Purpose |
| --- | --- |
| `JWT_SECRET` | Signs access and refresh tokens. At least 32 characters. |
| `SECRETS_ROOT_KEY` | Wraps every per-project data key. 64 hex characters. Losing it makes stored project credentials unrecoverable. |

The capability switches, each defaulting to off, each enforced at the process layer:

| Variable | Enables |
| --- | --- |
| `GIT_PUSH_ENABLED` | `git push` (ADR-021) |
| `GIT_AUTO_PUSH_ON_TASK` | Routine development/staging pushes without an approval (ADR-041) |
| `VALIDATION_ENABLED` | A real Odoo test run (ADR-027) |
| `PROJECT_PROVISIONING_ENABLED` | Provisioning a real instance (ADR-039) |
| `PROJECT_HTTPS_ENABLED` | Certificate issuance for a provisioned project (ADR-040) |
| `GITHUB_REPOSITORY_ENABLED` | Creating a GitHub repository for a created project (ADR-041) |

Configuration also refuses to start a production deployment on the development
providers: `SECRETS_PROVIDER=envelope` and `AI_PROVIDER=mock` are rejected when
`NODE_ENV=production`. A misconfigured capability is refused at boot rather than at
first use.

Never commit `.env`.

---

## 9. What is deliberately not built

Each is recorded in an ADR where it is a deviation from the approved architecture.

1. Temporal durable execution (ADR-011).
2. Firecracker or Kata workspace isolation (ADR-013, ADR-019). Validation now runs
   real Odoo code, bounded by the controls of ADR-027 — a scratch database, a
   fixed runtime, no customer credential — rather than by a microVM. The microVM
   remains the correct long-term boundary.
3. HashiCorp Vault (ADR-014).
4. Keycloak or Ory, and third-party OAuth sign-in (ADR-015).
5. Production deployment automation, production database access and unrestricted
   shell execution — out of scope for the MVP by the architecture itself.
6. The Python on-premise connector (Phase 6). The on-premise execution mode of
   ADR-028 works without it.

---

## 10. Where to read next

| Question | Document |
| --- | --- |
| What is built, and what was found while building it | `docs/implementation-status.md` |
| What was run, and what it printed | `docs/verification-log.md` |
| Why a decision was taken | `docs/adr/` |
| How to create and run a project | `docs/guides/creating-and-running-projects.md` |
| How to stand this up on a server | `docs/INSTALL-SERVER.md` |
| How to run it locally | `RUNNING.md` |
