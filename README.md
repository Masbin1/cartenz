# LinkedERP AI Development Agent

An AI-assisted development platform for Odoo projects. A user connects a project,
describes a change in plain language, and an agent analyses the project, produces
an implementation plan, and — after human approval — modifies the code, validates
it, commits and pushes.

The governing architecture is held in `docs/reference/`:

1. `LinkedERP_AIDevAgent_TechArchitecture_v1.2_2026-08-27_1.docx`
2. `LinkedERP_AIDevAgent_FrameworkSelection_v1.0_2026-08-27_1.docx`

Those documents are authoritative. Implementation decisions that deviate from
them, or that resolve a conflict within them, are recorded in `docs/adr/`.

**Status: Phase 3 complete — the agent is model-driven.** The agent clones a
repository into an isolated per-task workspace, detects the Odoo series from the
project's own manifests, asks a model for a plan, carries that plan out through a
tool loop after a person approves it, produces a real `git diff` for review, and
creates a real commit.

The model is bound behind a provider-agnostic interface (ADR-03). With nothing
configured it binds a **scripted provider** that runs the same loop and calls the
same tools without making a network call — so the platform works out of the box,
and every plan it produces says it was not model-authored.

**Which model, and with whose key, is set in the portal at `/settings`** (ADR-023).
Anthropic, any OpenAI-compatible endpoint, or no model at all. The token is entered
there, sealed by the secrets provider on arrival, and returned by no endpoint — the
response shape the browser receives has no field that could carry one. There is a
connection test that makes a single call carrying no repository content, so a wrong
key is found before a task is submitted rather than after a plan has been approved.
`AI_PROVIDER` and `AI_API_KEY` still work, and remain the fallback.

**Everything sent to a provider, and everything received, passes the AI data
boundary first** (chapter 12, ADR-020). That is not configurable.

Two capabilities remain simulated, and the portal states which on every task:

- **Validation** — running a linter or a test suite executes the repository's own
  code, which is the risk the microVM boundary exists for (ADR-013, ADR-019).
- **`git push`** — the one operation that leaves the platform. Phase 5.

**The platform cannot push, and that is enforced where it cannot be undone by
accident** (ADR-021). `GIT_PUSH_ENABLED` defaults to false, and with it false the
process layer refuses `git push` before a process is built — not the tool, the
process layer, so no permission and no approval can cause a push.
`infrastructure/scripts/probe-push-refusal.js` asks the compiled artefact to push
in seven forms and reports each refusal. With pushing off the platform does not
ask for push approval either: it completes and says the branch is in the workspace.

**A task targets a named environment, and production is refused** (ADR-021). On
Odoo.sh an environment is a branch, so a project declares its branches and what
each one is. A task pointed at a `production` environment is refused before any
row is written, and the refusal is in the audit trail. This is a closed door rather
than an approval gate, because Phase 5 does not exist yet and a gate in front of a
capability that does not exist suggests the door opens.

---

## 1. Architecture at a glance

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
| Git and process execution | One chokepoint, argument vectors only, never a shell (ADR-019); `git push` refused there unless enabled (ADR-021) |
| Target environments | A project declares its branches; production is not targetable (ADR-021) |
| Workspaces | Real per-task clone, quota-bounded, destroyed with the run |
| Code understanding | Candidates ranked by what they declare, not by text match (ADR-025) |
| Repository writes | `edit_file` replaces one quoted region; whole-file rewrites are bounded (ADR-022) |
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

---

## 2. Repository layout

```
.
├── backend/            NestJS API and agent worker (one build, two entry points)
│   ├── drizzle/        Generated migrations
│   └── src/
│       ├── agent/
│       │   ├── analysis/       Odoo manifest parsing, code search, project memory
│       │   ├── git/            Git service, URL validation, credential lease
│       │   ├── orchestration/  Workflow, planner, queue orchestrator
│       │   ├── tools/          Registry, permission validator, real and simulated tools
│       │   └── workspace/      Workspace manager and path containment
│       ├── core/       Config, database, redis, process, secrets, authz, audit, events
│       └── modules/    auth, organizations, projects, tasks, approvals, realtime
├── frontend/           Next.js portal
├── connector/          Python on-premise connector (Phase 6, not started)
├── infrastructure/
│   ├── compose/        docker-compose.yml
│   ├── docker/         Dockerfiles
│   ├── proxy/          Nginx configuration
│   └── scripts/        Local runtime and verification scripts
└── docs/
    ├── adr/            Architecture decision records
    ├── reference/      The approved architecture documents
    ├── implementation-status.md
    └── verification-log.md
```

---

## 3. Running the stack

Step-by-step instructions, including database setup, hot reload, logs and
troubleshooting, are in **[RUNNING.md](RUNNING.md)**. A summary follows.

### 3.1 With Docker (the standard path)

Requires Docker with Compose v2.

```bash
cp .env.example .env
# Set JWT_SECRET and SECRETS_ROOT_KEY: openssl rand -hex 32
# Set POSTGRES_PASSWORD.
docker compose -f infrastructure/compose/docker-compose.yml up -d --build
```

The portal is then on `http://localhost:8080`, behind the reverse proxy that also
serves the API and the WebSocket.

This path is authored but has **not** been executed on the host used for the
foundation milestone, which has no container runtime. See ADR-012.

### 3.2 Without Docker (verified on the foundation host)

Requires Node.js 20+, a reachable PostgreSQL, a C toolchain and network access.
No root privilege is needed; Redis is built into `~/.local`.

```bash
./infrastructure/scripts/bootstrap-env.sh    # generates .env with fresh secrets
# Set DATABASE_URL in .env to your PostgreSQL instance.
./infrastructure/scripts/dev-up.sh           # builds, migrates, starts everything
```

| Service | Address |
| --- | --- |
| Portal | http://localhost:3000 |
| API | http://localhost:4000/api/v1 |
| Readiness | http://localhost:4000/api/v1/health/ready |

Logs are written to `.runtime/*.log`. Stop with
`./infrastructure/scripts/dev-down.sh`.

---

## 4. Verification

One command runs everything and fails if anything fails:

```bash
./infrastructure/scripts/verify-all.sh           # everything
./infrastructure/scripts/verify-all.sh --fast    # skip the smoke suites
```

It exists because an aggregate that swallows exit codes is worse than none: a run
of the full suite once reported success while 107 checks were failing, because the
loop that ran them discarded each result. A smoke suite that could not run because
the stack was down is counted as a **failure**, not skipped — a suite that did not
run has not passed, and reporting it beside a green total is how a broken build
looks healthy.

The individual commands, when you want one of them:

```bash
npm run typecheck                                       # backend and frontend
npm test                                                # 402 unit tests
./infrastructure/scripts/smoke-test.sh                  # API and workflow
./infrastructure/scripts/smoke-test-repository.sh       # repository agent
./infrastructure/scripts/smoke-test-agent.sh            # model layer and AI boundary
./infrastructure/scripts/smoke-test-safety.sh           # push refusal and environments
./infrastructure/scripts/smoke-test-deletion.sh         # archive, restore, permanent delete
./infrastructure/scripts/smoke-test-validation.sh       # a real Odoo run, where one is configured
node infrastructure/scripts/probe-push-refusal.js       # the compiled runner, asked to push
node infrastructure/scripts/probe-validation-refusal.js # the compiled runner, asked to run Python
node infrastructure/scripts/probe-write-containment.js  # the write tools, aimed outside the workspace
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

`smoke-test.sh` exercises the documented workflow through the HTTP API only, and
asserts the security properties: organisation isolation, that a credential never
appears in a response or the audit trail, and that database export cannot be
granted.

`smoke-test-repository.sh` covers Phase 2: that the clone, the analysis, the diff
and the commit are real, that the generated XML is well formed, that workspaces are
destroyed, and that five hostile repository URLs are refused. Both need a
repository to clone, so they create a local fixture on first run
(`create-test-repository.sh`) and reach it through a `file://` remote — which
requires `GIT_ALLOW_LOCAL_REMOTES=true`, a setting refused in production.

`smoke-test-agent.sh` covers Phase 3: that the plan records what produced it, that
every model call is accounted for, that the boundary removes a planted credential
before it leaves the platform, that a redacted value is never written back into the
repository, and that the model is not offered `git_commit`, `git_push` or the
validation tools. It uses the `--with-secret` fixture variant.

`smoke-test-safety.sh` covers ADR-021: that a task cannot target production and
leaves no row when it tries, that the default target cannot be moved to production,
that both refusals are audited with the branch named, that the branch actually
cloned is the environment's and not the project default, and that with pushing
disabled no push approval is requested. Run it in both push configurations — it
reads `git.pushEnabled` from the server and asserts the behaviour that
configuration should have, so a guarantee is never tested in only one of them.

`smoke-test-repository.sh` §10b is the regression test for ADR-022: a fixture file of 16 KB,
eight times the audit filter's string limit, must survive a read-write round trip with its last
line intact **and must actually have been modified**. The second half matters — without it the
check passes when the write is refused and the file skipped, which is a guard working rather than a
round trip working. This test was confirmed to fail with the root cause reintroduced; a test that
has not been seen to fail is not yet a test.

`smoke-test-deletion.sh` covers ADR-024: that archiving destroys nothing and can be
undone, that an archived project can still be read but will not accept a task, a
connection, an environment or a permission change, that a permanent delete needs the
project's name typed back and refuses while a task is unfinished, and — the reason
the file exists — that a delete destroys the project's sealed credentials rather
than leaving them encrypted in the database, owned by nothing.
`secret_records.project_id` carries no foreign key by design, so nothing in the
database would have removed them.

`smoke-test-validation.sh` covers ADR-027, and needs a host with Odoo on it: that the
platform's credentials reach no customer database, that the validation role can
create databases and is not a superuser, that a task's results are real rather than
simulated, that no scratch database is left behind, and that the generated Odoo
configuration never appears in the diff a person is asked to approve. It reports
which of those is missing rather than failing obscurely.

The unit tests are written to assert refusal rather than success: a path-containment
test that only checked the happy case would pass against an implementation that
checks nothing. Results are recorded in `docs/verification-log.md`.

---

## 5. The workflow

```
Connect project
  → Submit prompt            POST /api/v1/projects/{id}/tasks
  → ANALYZING                real clone, real Odoo detection, real code search
  → PLANNING                 a model call, through the AI data boundary
  → WAITING_APPROVAL         the plan is put to a person
  → IMPLEMENTING             a tool loop the model drives, every call mediated
  → TESTING                  simulated: executing repository code needs isolation
  → COMMITTING               real commit on the AI branch
  → WAITING_APPROVAL         the push is put to a person
  → PUSHING                  simulated: Phase 5 sends it to the remote
  → COMPLETED                workspace destroyed
```

Branches follow `ai/task-{task_id}-{short-description}`. The agent never commits
to the default branch.

---

## 6. Environment

`.env.example` is the contract and documents every variable. Two values have no
default and the API refuses to start without them:

| Variable | Purpose |
| --- | --- |
| `JWT_SECRET` | Signs access and refresh tokens. At least 32 characters. |
| `SECRETS_ROOT_KEY` | Wraps every per-project data key. 64 hex characters. Losing it makes stored project credentials unrecoverable. |

Configuration also refuses to start a production deployment on the development
providers: `SECRETS_PROVIDER=envelope` and `AI_PROVIDER=mock` are rejected when
`NODE_ENV=production`.

Never commit `.env`.

---

## 7. What is deliberately not built

Each is recorded in an ADR where it is a deviation from the approved
architecture.

1. Temporal durable execution (ADR-011).
2. Firecracker or Kata workspace isolation, and execution of repository or
   AI-authored code (ADR-013, ADR-019). This is what keeps validation simulated.
3. HashiCorp Vault (ADR-014).
4. Keycloak or Ory, and third-party OAuth sign-in (ADR-015).
5. A push to a customer repository — Phase 5. Everything up to and including the
   commit is real; the push is not.
6. Targeted edits. The write tools replace a whole file, which is why a file
   containing a hardcoded credential cannot be rewritten at all — the boundary
   removes the credential before the agent reads it, and writing the redaction back
   would delete the original (ADR-020, section 5).
7. Production deployment automation, production database access and unrestricted
   shell execution — out of scope for the MVP by the architecture itself.
8. The Python on-premise connector (Phase 6).

There is no shell tool of any kind, and the tool registry is tested to assert that
none exists. `CommandRunner` will start only `git`, and the test asserts it refuses
`sh`, `bash`, `node`, `python3`, `curl` and `rm`.

**A real model has not been called.** `AiSdkModelProvider` is written and
type-checked, but no API key exists on the development host, so the SDK integration
itself is unexercised. Everything around it — the loop, the boundary, the budgets,
the tool mediation, the accounting — is exercised by the scripted provider, which
runs the same path. Setting `AI_PROVIDER` and `AI_API_KEY` is the whole of closing
that gap.

---

## 8. Next milestone

Two small things first.

**Configure a provider and run the agent for real.** Set `AI_PROVIDER` and `AI_API_KEY`. That
closes the one gap Phase 3 could not, and makes the prompt-injection test meaningful: show the
model a hostile file and confirm the refused tool call appears in the audit trail.

**Targeted edits.** `update_file` replacing a whole file is both the riskiest thing a model can do
to a repository and the reason a credential-bearing file cannot be changed at all. An old-fragment
and new-fragment contract removes both problems.

Then **Phase 5 — Git automation**: a real push, a pull request and build monitoring. Everything up
to the commit is already real and the approval gate for the push already exists.

**Phase 4 (real validation)** still waits for the isolation boundary of ADR-013. See
`docs/implementation-status.md` for the reasoning on sequencing.
