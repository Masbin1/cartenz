# Verification Log

A record of what was actually executed and what it returned. Nothing is recorded
here that was not run.

## Environment

| Item | Value |
| --- | --- |
| Date | 27 August 2026 |
| Host | WSL2, Ubuntu 22.04 |
| Node.js | v20.20.2 |
| npm | 10.8.2 |
| PostgreSQL | 14, reachable on 127.0.0.1:5432 |
| Redis | 7.2.5, built from source into `~/.local/bin` (no root, no package manager) |
| Docker | **Not available on this host** |
| Runtime path | Unprivileged local path (ADR-012) |

---

## 1. Milestone gate: Phase 1 foundation

| Requirement | Verified | Evidence |
| --- | --- | --- |
| Frontend starts | Yes | `dev-up.sh` step 5; `GET /login` returned 200 |
| Backend starts | Yes | `dev-up.sh` step 3; all routes mapped in `.runtime/api.log` |
| Backend health endpoint | Yes | `GET /api/v1/health` returned 200 |
| PostgreSQL connectivity | Yes | `GET /api/v1/health/ready` reported `postgres: up` |
| Redis connectivity | Yes | `GET /api/v1/health/ready` reported `redis: up` |
| Worker runs and consumes | Yes | `.runtime/worker.log` shows jobs processed and completed |
| Clean start and stop cycle | Yes | `dev-up.sh` then `dev-down.sh`: all four services stopped, all three ports released, no orphan |
| Migrations apply | Yes | 15 tables created; verified with `psql` |
| Docker Compose starts the stack | **No — not verified** | No container runtime on this host (ADR-012) |
| Environment variables documented | Yes | `.env.example`, 84 lines, every variable declared |
| No real secrets committed | Yes | `.env` is git-ignored; `.env.example` ships both secrets blank |

---

## 2. Build and static analysis

```
$ npm run typecheck --workspace backend        # tsc --noEmit
PASS: no type errors

$ npm run typecheck --workspace frontend       # tsc --noEmit
PASS: no type errors

$ npm run lint --workspace backend             # eslint src --ext .ts
LINT CLEAN

$ npx next lint                                # frontend
✔ No ESLint warnings or errors

$ npx nest build                               # backend
BUILD OK

$ NODE_ENV=production npx next build           # frontend
✓ Compiled successfully in 4.6s
✓ Generating static pages (9/9)
```

Ten routes built: `/`, `/login`, `/register`, `/dashboard`, `/projects`,
`/projects/new`, `/projects/[projectId]`, `/projects/[projectId]/agent`,
`/projects/[projectId]/settings`, `/_not-found`.

---

## 3. Unit tests

```
$ npm test --workspace backend

PASS src/agent/task-state.spec.ts
PASS src/agent/tools/permission-validator.spec.ts
PASS src/agent/workspace/workspace-manager.spec.ts
PASS src/core/audit/redact.spec.ts
PASS src/core/authz/agent-permissions.spec.ts
PASS src/core/config/configuration.spec.ts
PASS src/modules/auth/password.service.spec.ts
PASS src/modules/projects/project-specification.spec.ts

Test Suites: 8 passed, 8 total
Tests:       76 passed, 76 total
```

What the suites cover, and why these were chosen:

| Suite | Property defended |
| --- | --- |
| `task-state` | Every state is reachable, every terminal state is closed, the approval gate cannot be skipped, a terminal task cannot be rewritten |
| `permission-validator` | The tool gate fails closed: unregistered, ungranted, malformed and unapproved requests are all refused; no shell tool is registered |
| `redact` | No password, token, API key or credential shape survives into an audit record, at any nesting depth |
| `agent-permissions` | The data-blind default posture holds; export and backup are not grantable at all |
| `configuration` | A deployment missing a required secret fails at boot, not at first request; production rejects the development providers |
| `password.service` | Correct verification, per-hash salting, no plaintext retained, malformed hashes deny rather than error |
| `project-specification` | The documented specification shape; requirements are stably identified; the target is always development |
| `workspace-manager` | Branch names are safe on a Git command line and match the documented format |

---

## 4. End-to-end smoke test

```
$ ./infrastructure/scripts/smoke-test.sh

  Passed: 52    Failed: 0
```

Exercised through the HTTP API only, with no database access and no internal
imports, so it verifies the API as a client sees it. The twenty groups:

1. Health — liveness and readiness both 200.
2. Authentication is the default — an unauthenticated `GET /projects` is 401.
3. Registration creates a user, an organisation, and makes the registrant owner.
4. A password below the minimum length is refused.
5. Sign-in succeeds; a wrong password is 401.
6. A repository project is created.
7. A repository project without a repository URL is refused at submission.
8. An AI project is created with a specification: framework, `REQ-001`, and a
   development deployment target.
9. Agent permissions default to the data-blind posture.
10. Granting `database_export` is refused.
11. A credential is sealed: `hasCredentials` is true, and the value appears in
    neither the creation response nor the project detail.
12. A prompt creates a task and returns immediately with its initial status.
13. The task reaches `waiting_approval` unaided, with a plan and an AI branch.
14. Approving the plan resumes it: files modified, validation passed, and the
    second gate is the push.
15. Approving the push completes the task, with a commit recorded.
16. 30 action rows and 44 event rows were written for one task.
17. Cancellation works; cancelling a settled task is 409.
18. Organisation isolation: another organisation gets 404 on both the project
    and the task — not 403, so existence is not disclosed.
19. The audit trail contains `project.created`, `task.created`, `task.started`,
    `approval.requested`, `approval.granted` and `task.completed`, and contains
    no credential.
20. Refresh tokens are single-use: reuse is 401.

---

## 5. Manual verification through the portal

Driven through a real browser against the running stack.

| Step | Result |
| --- | --- |
| `/login` renders | Yes |
| Registration through the form | Account and organisation created, redirected to the dashboard |
| Dashboard | Metrics rendered; audit panel showed `organization.created` and `user.registered` |
| New project, connect-existing flow | Project created with a GitHub credential |
| Project detail | Connection shown as `Connected`, "Credential held (encrypted, never returned)"; permissions listed with record access denied |
| Agent workspace, three panes | Left: project and task history. Centre: prompt, activity, plan. Right: task status, files, validation, approvals |
| Prompt submitted | Task `task_571653` created; WebSocket showed **Live** |
| Live activity stream | Tool calls, agent narration and state changes streamed with server timestamps |
| Plan rendered | 4 steps, 2 files, 3 validation tools, 2 risks, attributed to `mock-planner (mock/mock-agent-v1)` |
| First approval gate | "Approval required: Implementation plan", with summary, step count and file list |
| Approving the plan | Task resumed: 2 files modified, 3 validation steps passed, commit created |
| Second approval gate | "Approval required: Git push", showing the branch and the commit message |
| Approving the push | Task reached `Completed`; branch `ai/task_571653-add-customer-reference-field-sales`, commit `simulated-task_571653` |
| Simulation disclosed | "This task ran on the simulated tool set. No file was written, no command was executed and no repository was contacted." |

A screenshot could not be captured: the browser pane was not displayed during the
session, so the page was not compositing frames. The verification above is from
the rendered DOM text, which is the same source the user reads.

---

## 6. Defects found and fixed during verification

Recorded because each was a real defect in the implementation, not a test
artefact.

| Defect | Cause | Fix |
| --- | --- | --- |
| Task creation returned 500 | BullMQ rejects a custom job id containing a colon; the ids were `execute:{taskId}` | Job ids built by one helper using a hyphen, so `start` and `cancel` cannot diverge |
| Approving did not resume the task | The workflow's `waiting_approval` branch returned without deciding where to resume | Added `resumeFromApproval`, which reads the recorded decision and resumes into `implementing` or `pushing` |
| Push approval failed the task | The state machine had no `waiting_approval -> pushing` edge, so the second gate had no return path | Added the edge; recorded in ADR-018 with the reasoning |
| Lifecycle audit events absent from the organisation trail | `TaskRepository.transition` wrote audit records with no organisation or project scope, so they were invisible to the scoped query | The update's `returning()` now yields both ids, which are passed to the audit record |
| Services died when the shell exited | Background processes were not detached, so SIGHUP killed them | `dev-up.sh` starts each service under `setsid nohup` |
| Frontend production build failed on `/500` | `next build` inherited `NODE_ENV=development` from the shared `.env` | `build.sh` and the Dockerfile force `NODE_ENV=production` for the Next.js build |
| Stopping the stack orphaned `next-server`, which kept holding port 3000 | The pid file recorded the npm wrapper, not the server it spawned, so the wrapper was killed and its child survived | `dev-down.sh` signals the process group rather than the pid, `dev-up.sh` starts `next` directly, and any process still holding a stack port is now reported |
| The worker never exited on SIGTERM and was always killed | Nest's shutdown hooks closed the Redis connections first, so the BullMQ worker's own close waited forever on a blocking read against a closed connection | The worker handles the signals itself and closes in the correct order — worker first, then the application — with a 25-second forced-exit backstop |

---

## 7. Not verified

Stated explicitly rather than left to inference.

1. **The Docker Compose path.** No container runtime on this host. The Compose
   file, both Dockerfiles and the Nginx configuration are authored and reviewed
   but have never been executed. This is the first thing to verify on a host with
   Docker.
2. **Real Git, filesystem, shell or Odoo operations.** Not implemented; the tools
   are simulated by design (ADR-013).
3. **Real AI model calls.** The mock provider makes no outbound request.
4. **Vault, Temporal, Keycloak and Firecracker.** Not deployed (ADR-011, 013,
   014, 015).
5. **Load, concurrency and failover.** Not exercised. The worker was run at
   concurrency 4 with a single instance.
6. **The Python connector.** Not started.

---
---

# Phase 2 — Repository Agent

Recorded 28 August 2026. Same host and runtime path as Phase 1.

## 8. Milestone gate: Phase 2

| Requirement | Verified | Evidence |
| --- | --- | --- |
| Repository cloned into a managed workspace | Yes | Base commit `155c96cd` recorded on the task; clone logged with file and byte counts |
| AI branch created at the base commit | Yes | `ai/task_277229-add-customer-reference-field-sales` |
| Code search over the real clone | Yes | Four matches for `sale.order`; the plan cites the files they are in |
| File read and modification | Yes | Two files changed, confirmed by numstat |
| Git branch and Git diff | Yes | Real unified diff, +11/-0, reviewable in the portal |
| Odoo version detected from the repository | Yes | 18.0 from two module manifests, not from the project setting |
| Modules listed from the repository | Yes | omnisurge_base, omnisurge_sale, with versions and file counts |
| Real commit | Yes | 40-character object id; the Phase 1 placeholder form asserted absent |
| Workspaces destroyed with the task | Yes | Directory empty after six runs; all rows released |
| Validation still simulated | Yes, by design | Asserted as an exact set in permission-validator.spec.ts |
| Push still simulated | Yes, by design | Same assertion; the portal states it per task |

## 9. Security controls, verified by refusal

The tests assert what is refused, not what succeeds. A control tested only on its
happy path would pass against an implementation that checks nothing.

| Control | Refusals asserted |
| --- | --- |
| `git-url.spec.ts` | ext transport; local paths unless enabled; bare relative and absolute paths; plaintext and unauthenticated schemes; a URL beginning with a hyphen; embedded credentials; control characters; no repository path; query strings. Branch names: option-like, shell metacharacters, `..`, `//`, `.lock` |
| `workspace-path.spec.ts` | Upward traversal; absolute and drive-qualified paths; a symlink to a file outside the workspace; a file reached through a symlinked directory; a circular symlink; writing through an existing symlink; a new file under a symlinked directory; the `.git` directory |
| `command-runner.spec.ts` | Every executable but git; a NUL byte in an argument; seven shell-injection strings proven inert by asserting the sandbox is untouched. Also that the platform environment is not inherited and the forced git configuration is applied |
| `manifest-parser.spec.ts` | A manifest containing an `os.system` call is parsed, not executed; commented-out and docstring keys ignored; a module-only version not misread as an Odoo series |
| `code-search.spec.ts` | Ignored directories skipped; symlinks not followed; result, file and depth caps enforced; a catastrophic-backtracking pattern treated as a literal and returning promptly |

The API-level refusals are additionally asserted end to end: five hostile
repository URLs are refused at project creation with HTTP 400.

## 10. Build and tests

```
$ npx tsc --noEmit        # backend    PASS
$ npx tsc --noEmit        # frontend   PASS
$ npx eslint src --ext .ts            PASS
$ npx next lint                       No ESLint warnings or errors
$ npx jest --ci
Test Suites: 14 passed, 14 total
Tests:       173 passed, 173 total

$ ./infrastructure/scripts/smoke-test.sh              Passed: 55   Failed: 0
$ ./infrastructure/scripts/smoke-test-repository.sh   Passed: 38   Failed: 0
```

Six new suites: `git-url`, `workspace-path`, `code-search`, `command-runner`,
`manifest-parser`, `agent-planner`.

Migration `0001_phase2_repository_agent.sql` applied: two new tables
(`agent_workspaces`, `project_memory`) and four new columns on `agent_tasks`. The
migration is additive, so no existing row became invalid.

## 11. Manual verification through the portal

| Step | Result |
| --- | --- |
| Project created against a local fixture | Accepted; a plaintext-HTTP and an ext-transport URL were refused with a specific message |
| Prompt submitted | Timeline showed the clone, the version detection, the module list and the search, in order |
| Plan | Cited `omnisurge_sale/models/sale_order.py` and `omnisurge_sale/views/sale_order_views.xml` - files that exist |
| Task inspector | Base commit shown; "the repository was cloned, read and modified for real"; the two simulated capabilities named individually |
| Review diff | Per-file panels, +/- counts, hunk headers, old and new line numbers |
| Generated XML | Block inside the closing root; one root element |
| Commit | Real object id shown, not a placeholder |
| Project memory panel | Odoo 18.0, Python 3.11, 11 files, both modules with versions and the application flag |

## 12. Defects found and fixed in Phase 2

| Defect | Cause | Fix |
| --- | --- | --- |
| An `ssh://git@host/repo` remote was refused as embedding credentials | The validator treated any username as a smuggled token, but for SSH the account name is not a secret and git needs it | Credential rules split by scheme: SSH keeps its username, HTTPS refuses both parts, a password is refused everywhere |
| Project creation refused a local URL that the clone path accepts | The DTO re-implemented remote-URL policy and disagreed with the authoritative validator | The DTO checks shape only; the service validates through the single authority, so a bad URL is refused when it is typed rather than at first task |
| Generated XML had two root elements | The block was appended after the closing root, which Odoo refuses to load | XML blocks are inserted before the closing root; asserted by test |
| A run that really cloned and committed still reported itself simulated | One boolean cannot answer both "did anything real happen" and "which of these results are fabricated" | Replaced in the interface by `simulated_capabilities`, which names the categories |
| Duplicate tool registration would have failed at boot | The simulated Odoo tools were left in place when the real ones were added | Removed from the simulated set; a test now asserts the exact real and simulated sets |
| The activity stream lost the clone and analysis narration | Events published between the history fetch and the socket subscription belonged to neither | The history is fetched again on the server's subscription confirmation; merging by sequence makes it idempotent |
| Selecting a second task showed the first task's activity and none of its own | Events were cleared only when the task became null, and sequence numbers restart per task, so stale events occupied the new task's sequences and its own events were discarded as duplicates | Events are cleared on every change of task |
| A task on a project with no repository failed after a person had approved its plan | The workflow discovered the missing repository at the implementing step | Refused at submission, with a message naming the one thing the user needs to do |
| The dev scripts could not source `.env` | `GIT_AUTHOR_NAME` held an unquoted value containing spaces, so the shell read the second word as a command | Quoted, and the constraint documented in `.env.example` |

## 13. Not verified in Phase 2

1. **The Docker Compose path** - still unverified; no container runtime on this host.
2. **A real remote over HTTPS or SSH.** Verification used a local fixture, which
   exercises the same clone path but not network authentication. The credential lease
   is therefore built and reviewed but has not been exercised against a real private
   repository.
3. **Real validation and a real push** - simulated by design.
4. **A large repository.** The fixture is eleven files. The quota, the walk caps and
   the truncation paths are unit-tested but have not met a real Odoo monorepo.
5. **Concurrent tasks on one project.** Each gets its own workspace by construction,
   but simultaneous runs were not exercised.

---
---

# Phase 3 — AI Development Agent

Recorded 28 August 2026. Same host and runtime path as Phases 1 and 2.

## 14. Milestone gate: Phase 3

| Requirement | Verified | Evidence |
| --- | --- | --- |
| Model bound behind a provider-agnostic interface | Yes | `ModelProvider` with three implementations; only the guarded one is exported |
| Vercel AI SDK wired for hosted and self-hosted providers | Authored, **not exercised** | No API key available on this host; see section 18 |
| Plan produced through the model layer | Yes | `plan.generatedBy` records the provider; validated against a zod schema before persistence |
| Implementation driven by a tool loop | Yes | 6 tool calls per task, each through the permission validator |
| Every model call recorded | Yes | `agent_model_calls`: provider, tokens, steps, tool calls, boundary findings |
| AI data boundary on every call, both directions | Yes | Verified end to end against a planted credential; see section 16 |
| Bounded iteration | Yes | Step, tool-call, token and timeout budgets; exhaustion reported, not hidden |
| Model cannot commit, push or validate | Yes | `availableToModel: false`, asserted for six tools in the smoke test |
| Prompt injection contained by the tool layer | By construction | The loop adds no new execution path; every call meets the same validator |

## 15. Build and tests

```
$ npx tsc --noEmit        # backend    PASS
$ npx tsc --noEmit        # frontend   PASS
$ npx eslint src --ext .ts            PASS
$ npx next lint                       No ESLint warnings or errors
$ npx jest --ci
Test Suites: 19 passed, 19 total
Tests:       233 passed, 233 total

$ ./infrastructure/scripts/smoke-test.sh              Passed: 55   Failed: 0
$ ./infrastructure/scripts/smoke-test-repository.sh   Passed: 38   Failed: 0
$ ./infrastructure/scripts/smoke-test-agent.sh        Passed: 31   Failed: 0
```

Five new suites: `ai-boundary.service`, `apply-rules`, `guarded-model-provider`,
`repository-write-guard`, and the extracted `generated-block` and `odoo-target`.

Migration `0002_phase3_ai_agent.sql` applied, adding `agent_model_calls`. Additive,
so no existing row became invalid.

## 16. The AI data boundary, verified end to end

The fixture has a second variant, `--with-secret`, which plants a GitHub token and
a personal email address in the model file the agent reads. Running a task against
it produced:

```
planning: mock/mock-agent-v1, external=false, steps=1, tokens=581
  boundary: 2 redaction(s), refused=false
    github_token x1 (secret)
    email_address x1 (pii)
```

Both were removed before the material left the platform, and the recorded finding
names the rule without carrying the matched text.

Unit tests assert refusal rather than success, as in Phase 2:

| Property | Asserted |
| --- | --- |
| Secrets removed | Nine credential formats, a PEM block, a URL password, and an assignment with no recognisable format |
| A secrets file is refused, not redacted | Redacting it would still send its structure and variable names |
| Personal data removed | Email, Luhn-valid card number, plausible SA identity number |
| Source survives | Ordinary Odoo source passes byte-identical; example and maintainer addresses are kept; a sixteen-digit identifier and an implausible thirteen-digit number are kept |
| Customer data refused | pg_dump, INSERT batch, customer CSV, JSON record array |
| Legitimate data files pass | An Odoo `ir.model.access.csv` is not mistaken for a customer table |
| Both directions | A secret repeated in the model's own output is removed |
| Tool results filtered | `read_file` output is filtered before the model sees it; a customer CSV is withheld without halting the task |

## 17. Defects found and fixed in Phase 3

| Defect | Cause | Fix |
| --- | --- | --- |
| **The AI data boundary was silently deleting customer credentials** | The boundary removes a credential before the model reads the file; the write tools replace a file entirely; so the agent wrote the redaction back, replacing the real credential with a placeholder. The commit looked ordinary and nothing failed | `create_file` and `update_file` refuse any content carrying a redaction marker. The task fails with a message naming the file and what to do. Recorded as section 5 of ADR-020, with targeted edits named as the real fix |
| The model never saw any tool result | The workflow's loop callback returned only a status, discarding the tool's output, so a model that read a file was told "succeeded" and nothing else | `callTool` returns the output as well as the status |
| A value matching two boundary rules was redacted and counted twice | Rules were applied sequentially, each to the previous output, so a token matched by format and again by variable name was replaced twice and inflated the count shown to users | Single-pass application: every rule is evaluated against the original text, overlaps are resolved once |
| The general rule won an overlap over the specific one | Overlaps were resolved by position, and the general assigned-secret rule starts one character earlier at the opening quote. It stripped the quotes too, leaving `KEY = [redacted]` — invalid Python for the model to read | Resolved by declaration order instead, so the specific rule wins and the redacted assignment stays syntactically valid |
| A multi-line record set inside a tool result was not detected | The guard serialised the result to JSON before filtering, and JSON escapes newlines, so the structural filter — which reasons about rows and headers — saw one long line | `filterDeep` walks the structure and filters each string as the string it is |
| The scripted provider produced no change | Its loop only read files, so a task on the mock provider always failed with "made no change to the working tree" | It now reads each planned file and writes it back, exercising the read-then-write pattern the instruction demands |
| A generated XML comment could contain `--` | XML forbids `--` inside a comment, so a summary containing one produced a file no parser accepts | Collapsed on write; asserted by test |
| Two config tests asserted removed behaviour | A named provider now requires a key at boot | Updated, and six tests added for the new provider and budget validation |
| One fixture could not serve both purposes | The planted credential made the Phase 2 test's second file unwritable, which is correct behaviour but not what that test is about | Two fixtures: a clean one for the API and repository tests, and `--with-secret` for the boundary test |

## 18. Not verified in Phase 3

Stated explicitly, because the gap here is larger than in previous phases.

1. **No real model has been called.** There is no API key on this host, so
   `AiSdkModelProvider` is authored and type-checked but has never made a request.
   Everything else — the loop, the boundary, the budgets, the tool mediation, the
   persistence — is exercised by the scripted provider, which runs the same path.
   What is unverified is the SDK integration itself: the request shape, the
   structured-output parsing, the error mapping and the token accounting.
   **This is the first thing to do when a key is available**, and it needs nothing
   but setting `AI_PROVIDER` and `AI_API_KEY`.
2. **Prompt injection has not been tested against a real model.** The containment
   argument is structural — a model's authority is the tool registry, and the
   validator and approval gate are unchanged — and the structural part is tested.
   What is untested is whether a real model, shown a hostile file, attempts
   something the platform then refuses. That test is worth running once a provider
   is configured, and its expected result is a refused tool call in the audit trail.
3. **Plan quality.** The scripted provider produces a template. Whether a real
   model produces a *good* plan is the question Phase 3 exists to answer, and it
   cannot be answered here.
4. **Cost at scale.** Token counts from the scripted provider are estimated at four
   characters per token and are labelled as estimates in the portal.
5. **The Docker Compose path** — still unverified; no container runtime on this host.
6. **The portal's new surfaces were verified through the API and the built bundle,
   not visually.** The browser pane in this environment reported a 0×0 viewport and
   did not composite. The data the components render was confirmed through the API,
   and the component text was confirmed present in the built client bundle.

---

## Phase 3.5 — push safety and environments (ADR-021)

Built before connecting any real repository, because the two questions a customer asks first are
"what stops you pushing to my repository" and "how do I make sure you work on staging". Both had
answers that rested on the wrong thing: push did not happen because one tool happened to simulate
it, and staging was whatever the project's default branch was.

### Verified

| What | How | Result |
| --- | --- | --- |
| Push is refused at the process layer | `command-runner.spec.ts` | 26 tests pass |
| The compiled artefact refuses it too | `probe-push-refusal.js` against `backend/dist` | 8 checks pass, including `git -c … push` and `git --git-dir X push`; `git --version` still runs |
| No push approval is requested when pushing is off | `smoke-test-safety.sh` | Task completes and states pushing is disabled; zero `git_push` approval rows |
| The push approval gate still exists when pushing is on | `smoke-test-safety.sh` with `GIT_PUSH_ENABLED=true` | Gate present, task waits |
| A task cannot target production | `smoke-test-safety.sh` | Refused; no task row, no session row |
| The default target cannot be moved to production | `smoke-test-safety.sh` | Refused; default unchanged |
| Both refusals are audited | `smoke-test-safety.sh` | Two `environment.target_refused` rows naming the branch |
| The environment's branch is the branch cloned | `smoke-test-safety.sh` | `base_commit` equals the remote's `dev-1` tip |
| A branch the remote lacks fails clearly | `smoke-test-safety.sh` | Task fails naming the missing branch |
| Defaulting never selects production | `project-environments.spec.ts` | 16 tests pass |
| The SSH lease never weakens host key checking | `git-credentials.spec.ts` | 35 tests pass |
| No regressions | Full, repository and agent smoke tests, both push configurations | 54, 38, 31 — all pass |
| The portal carries the surfaces | `verify-portal-safety.sh` | 15 checks pass |
| Endpoints behave | Manual API run against the live stack | List, add, move-default, and both refusals confirmed |

### Not verified

1. **A real SSH remote.** Section 3 of ADR-021 is unit-tested and unexercised. The first real
   Odoo.sh connection will be its first test, and the host key policy is the thing to watch.
2. **A real remote of any kind.** Everything above runs against a local bare-repository fixture.
   `file://` exercises the same clone path but not authentication, latency or repository size.
3. **A real push.** `GIT_PUSH_ENABLED=true` was verified to restore the approval gate; the push
   itself is still the simulated tool of Phase 5. What is now true is that enabling the flag does
   not silently enable pushing — Phase 5 remains unbuilt, and the flag no longer pretends otherwise.
4. **The portal was not driven in a browser.** The browser pane in this environment cannot reach
   the dev server. Verified instead through the API, the production build, and the built client
   chunks. This proves the surfaces shipped, not that a person can click them.

---

## First run against a real customer repository (ADR-022)

`https://github.com/LinkedERP/Odoo.git`, branch `StagingDM`. Public, so no credential was needed
or handled. 12 addon modules, 247 files, 22 MB, no submodules, no vendored Odoo source.

### What worked first time

| What | Evidence |
| --- | --- |
| Clone of the named environment's branch | `Cloned StagingDM (StagingDM, staging) at cd6d415b` — matching `git ls-remote` |
| Working branch cut from it, not from the default | `base_commit` = `cd6d415b…`, branch `ai/task_856328-…` |
| A task on `production` (branch `main`) refused | No task row, no session row; audit row written |
| Odoo version detected | 19.0, from 12 manifests |
| Disagreement among manifests reported, not hidden | "Modules declare more than one Odoo series: 19.0 (5), 18.0 (1). 19.0 is taken as the target." |
| Pushing refused, and no push approval requested | Task completed stating the branch is in the workspace |
| Real commit on the task branch | 40-character SHA |

### What it found

**The platform produced a change that deleted 1043 lines of working code, and reported success.**

`redactMetadata` truncates strings to 2 KB for storage, that filter was applied to the value
returned to the agent, and so `read_file` returned the first 58 lines of a 43 KB module. The
scripted provider appended its block to that fragment and wrote the whole file back. Full analysis
and the fix in [ADR-022](adr/ADR-022-tool-output-fidelity-and-targeted-edits.md).

Two things about this are worth recording plainly:

1. **No test failed, before or after.** Every fixture file was under 2 KB, so the round trip was
   lossless in the tests and lossy in every real repository. The suite was testing a repository
   that did not resemble a customer's.
2. **The push refusal is why it was harmless.** The destruction stayed in a workspace that was then
   destroyed. Nothing reached GitHub. Had `GIT_PUSH_ENABLED` been true and the approval granted
   quickly, a day's work would have been overwritten on a staging branch.

### After the fix, same repository

`+11/−0`, previously `+12/−1043`. The hunk sits at line 1099 of the 1101-line module with zero
removals, and the XML block is inside `<odoo>`.

The regression test was checked in both directions: the root cause was reintroduced, the suite
re-run, and §10b failed on "the large file was not modified"; the fix was restored and it passed.
A test that has not been seen to fail is not yet a test.

### Still not verified against this repository

1. **Plan quality.** `AI_PROVIDER=mock`, so no model reasoned about anything. The scripted provider
   chose `linkederp_dashboard_studio/models/dashboard.py` for a `sale.order` change when
   `linkederp_sales_modifier/models/sale_order.py` already inherits that model. The write path is
   safe; the choice of file needs a model.
2. **Authentication.** The repository is public, so no token or SSH key was exercised. The SSH host
   key handling of ADR-021 §3 remains unit-tested and unrun.
3. **A real push.** Still the simulated tool of Phase 5.
4. **Whether the generated change is correct Odoo 19.** The block is a comment, and validation is
   simulated. Nothing here says the platform can write working Odoo code.

---

## Portal-managed model provider (ADR-023)

One screen for "which AI, and with whose key", because editing a file on the server and restarting
it is not a workflow the people who hold the account can use.

### Verified

| What | How | Result |
| --- | --- | --- |
| A provider that calls out with no key is refused at save | `model-settings.spec.ts` | Refused with the reason |
| `openai-compatible` with no base URL is refused | `model-settings.spec.ts` + live API | Refused |
| A plaintext http endpoint is refused | Live API | Refused, naming why: the prompt carries source |
| An over-long model name or key is refused, not sealed | `model-settings.spec.ts` | Refused |
| The key is absent from the API response | Live API, grepped for the key | Not present |
| The key is absent from the audit trail | Live API, grepped | Not present |
| The key is absent from the stored row and from `secret_records` plaintext | `psql` | `secret_ref` only; no plaintext |
| The audit row still records whether a key was set and replaced | `redact.spec.ts` + live API | Both booleans survive redaction |
| A wrong key reports the failure rather than throwing | `POST .../test` against Anthropic's live API | `ok: false`, `AI_APICallError` |
| Clearing reverts to the server default | Live API | Row deleted, `fromEnvironment: true` |
| Another organisation can neither read nor write it | Live API | 404 on both |
| The screen shipped and never renders a token | `verify-portal-settings.sh` | 13 checks |
| The AI boundary guarantee survived the refactor | `guarded-model-provider.spec.ts`; no export of the unguarded classes | Unchanged |
| No regressions | 294 unit tests; smoke 54 / 43 / 31 / 21 | All pass |

### Also fixed while here

**Two flaky tests.** `password.service.spec.ts` (scrypt, deliberately expensive) and
`command-runner.spec.ts` (spawns real git) were intermittently exceeding jest's 5-second default
under full parallelism — failing on time, not on behaviour. `testTimeout` is now 30 s. A flaky test
on a security assertion is worse than no test, because people learn to re-run it rather than read
it. Confirmed with three consecutive full runs.

### Not verified

1. **A successful call to a real provider.** No valid key has been supplied, and asking for one in
   chat is not how a key should travel. The rejection path was exercised against Anthropic's live
   API, so the request is well-formed enough to be rejected on authentication rather than on shape.
   Whether a real model produces a plan worth approving is still open, and is still the single most
   valuable thing left to test.
2. **The screen was not driven in a browser.** Verified through the API, the production build and
   the built client chunks. The browser pane here cannot reach the dev server.

---

## Project removal (ADR-024)

Archive, restore and permanent delete. `smoke-test-deletion.sh`, 50 checks, plus 9 unit tests.

### Two problems this surfaced

**Archiving was a trapdoor.** `requireProjectAccess` filtered archived projects out
unconditionally, so an archived project could not be read, restored or deleted — it left the list
and became unreachable. The filter is correct for the paths that do work; it now takes
`includeArchived`, and the split is asserted directly: an archived project answers 200 to a read and
404 to a task, a connection, an environment and a permission change.

**A plain delete would have orphaned credentials.** `secret_records.project_id` carries no foreign
key by design (ADR-014), so nothing in the database would have removed them. A customer's
repository credential would have stayed encrypted in the database forever, owned by nothing. This is
the check `smoke-test-deletion.sh` exists for — a delete that removed the project row and left the
secret behind would pass any test that only asked whether the project was gone.

### Verified

| What | Result |
| --- | --- |
| Archive hides without destroying | PASS |
| Archived: readable, but refuses tasks / connections / environments / permission changes | PASS |
| Restore brings it back, and tasks are accepted again | PASS |
| No confirmation, a wrong name, or the wrong case is refused with 400 | PASS |
| An unfinished task blocks the delete with 409, naming it; cancelling unblocks | PASS |
| The delete removes project, tasks, sessions, environments, connections, workspace rows | PASS |
| Sealed secrets destroyed, not orphaned | PASS |
| `project.deleted` survives with `project_id` nulled and the name in its metadata | PASS |
| Another organisation gets 404 and the project survives | PASS |
| Deleting twice is 404, not 500 | PASS |
| The portal surfaces shipped | PASS (16 checks) |

### Also fixed while here

The deletion smoke test's `sql` helper used `tr -d ' '`, which deletes *every* space rather than
trimming psql's padding. It silently mangled any value containing a space — a project name, for one —
into something the comparison then failed on. Replaced with a trim.

### Not verified

The screen was not driven in a browser; the browser pane here cannot reach the dev server. What is
proven is that the surfaces shipped and the API behaves, not that the buttons feel right to use.

---

## Setting up a real project that predated environments (amends ADR-021)

Found while preparing `github.com/LinkedERP/Odoo` for a step-by-step run. 89 projects in the local
database had no environment declared and could not run a task, including one on the owner's own
account.

| What | Result |
| --- | --- |
| A task on a project with no environments explains what to do | PASS |
| An environment can be added to an existing project from the portal | PASS (was missing entirely) |
| Declaring the production branch on such a project is accepted | PASS (**was refused**) |
| Declaring the same branch as development is still accepted | PASS (unchanged — this was never the problem) |
| With only production declared, a task is refused with the fix in the message | PASS |
| After declaring a development branch, the task runs on it and not on `main` | PASS |

The inversion is the finding worth keeping: the validation written for a creation-time *set* was
reused for a single *addition*, so the declaration that protects a production branch was refused
while the one that exposes it was allowed. Nothing failed, because no test asked.

---

## Model-aware file selection (ADR-025)

The remaining half of the first real-repository finding. The write path was made safe in ADR-022;
this is the *choice* of file, which was arbitrary.

### The problem, on the real repository

`search_code` is a text search, and candidates were passed on in the order the walker returned them.
So a change to `sale.order` was planned in a dashboard file that mentions the words in a comment,
while the module that declares `_inherit = 'sale.order'` went unread. The same ordering picks the
excerpts sent to the provider, so it decides what *any* model gets to reason about — this was never
only a scripted-provider problem.

### Verified live, `LinkedERP/Odoo` on `StagingDM`

Prompt: "Add a delivery reference field to the Sales Order model and show it on the order form view."

| | Model file | View file |
| --- | --- | --- |
| Before | `linkederp_dashboard_studio/models/dashboard.py` (does not extend it) | `linkederp_dashboard_studio/views/sale_order_sla_views.xml` (other module) |
| After ranking by `_inherit` | `linkederp_dashboard_studio/models/sale_order_sla.py` (extends it) | unchanged |
| After the filename tiebreak | `linkederp_sales_modifier/models/sale_order.py` | unchanged |
| After reading XML `<field name="model">` | `linkederp_sales_modifier/models/sale_order.py` | `linkederp_sales_modifier/views/sale_order_views.xml` |

Both halves in the module that owns the customisation. Diff `+8/−0` and `+3/−0`.

The three steps are listed because each was run against the repository and each moved the answer;
the second and third were not obvious in advance, and the third only became apparent after looking
at what the view files actually declare.

### Not verified

Whether a configured model, given the right files, produces a change worth approving. Unchanged, and
still the open question.

---

## On-premise, against a real host (ADR-026)

Inspected the on-premise layout at `~/linkederp`: Odoo 19 core and enterprise shared, per-client
addons and `odoo.conf` beside them, one Postgres serving twelve Odoo databases.

### The finding

**The platform's own credentials could open every Odoo database on the host**, including
`al3-prod-august`. Nothing read them — no tool opens a database, and export and backup cannot be
granted — but that is a property of the code, and on premise the credentials are what a customer is
relying on. Same shape as the `git push` guarantee removed in ADR-021.

Fresh Postgres grants `CONNECT` to `PUBLIC` on every database, which is why no one had to grant it.

### Verified

| What | Result |
| --- | --- |
| Startup names all 11 reachable databases and gives the `REVOKE` statement | PASS |
| The check asks `has_database_privilege` rather than connecting | PASS |
| `GET /health/posture` reports the posture; counts rather than names | PASS |
| An on-premise task against `file:///…/linkederp/Odoo` | Odoo 19.0, base `e88cbf3` = local HEAD |
| It planned the correct files | `linkederp_sales_modifier/models/sale_order.py` + its own views |
| The clone contains no untracked working-tree file | PASS |
| The boundary catches the key in the untracked settings file | PASS — `google_api_key` ×2 |
| No regressions | 332 unit tests; smoke 54 / 43 / 31 / 27 / 50 | PASS |

### Worth telling the operator

`config_linked_erp_pty_ltd_exported/data/90_settings.xml` in the LinkedERP working copy holds a
live-looking Google API key. It is **not committed** and not on GitHub — but it is also not
gitignored, and it is one of 107 untracked files a `git add -A` would stage.

### Not verified

That the platform is *unable* to reach those databases. On this host it is able to, until the
`REVOKE` is run. What is verified is that it says so, at every start.

---

## Phase 4 foundations: running Odoo for validation (ADR-027)

### What the host makes possible, and what it does not change

Odoo 19.0 runs here: `odoo-bin --version` answers, and every Python dependency is present. There is
a 17.0 core beside the 19.0 one, so multi-version is already the reality rather than a future
requirement.

What has not changed is that the `odoo` role is a Postgres superuser owning twelve customer
databases, and that an Odoo test run creates a database and writes. So the containment was built
first, and it is the part that is verified.

### Verified

| What | Result |
| --- | --- |
| Odoo 19.0 starts headlessly on this host | PASS — `Odoo Server 19.0` |
| `19`, `19.0`, `19.0.1.0.3` resolve to one runtime | PASS |
| A series with no configured runtime is skipped, naming what is configured | PASS |
| A relative core path is refused | PASS |
| The generated conf holds no password and puts the workspace clone first | PASS |
| `al3-prod-august` and every other customer database refused for create *and* drop | PASS |
| A database name Postgres would silently truncate is refused | PASS |
| Compiled artefact, validation off: no Python may start (4 forms) | PASS |
| Compiled artefact, validation on: only a configured `odoo-bin` (6 forms refused, control runs) | PASS |
| No regressions | 368 unit tests; smoke 54 / 43 / 31 / 27 / 50 | PASS |

### Not verified, and why

**An actual Odoo test run.** It needs a Postgres role that does not exist yet. The platform's role
cannot create databases — correctly. The customer's `odoo` role could, but its password lives in
their `odoo.conf`, which was deliberately not read, and authenticating as a cluster superuser is
precisely what this design refuses.

The attempt failed with `fe_sendauth: no password supplied`, which is the right failure: the
platform could not drive Odoo as the customer's role because it does not hold that credential.

### What an operator has to create

```sql
CREATE ROLE linkederp_validation LOGIN CREATEDB PASSWORD '...';
REVOKE CONNECT ON DATABASE "al3-prod-august" FROM PUBLIC;   -- and each of the others
```

Then `VALIDATION_ENABLED=true`, `ODOO_RUNTIMES=19.0=/home/masbintang/linkederp/base/odoo`,
`ODOO_SHARED_ADDON_PATHS=/home/masbintang/linkederp/base/enterprise`.

### The runner, built and wired

| What | Result |
| --- | --- |
| Refuses without a validation role, and says never to use the Odoo one | PASS |
| Refuses without a password | PASS |
| Skips a series it has no runtime for, naming what it has | PASS |
| Skips a change that touched no Odoo module | PASS |
| A malformed `ODOO_RUNTIMES` does not stop the platform booting | PASS |
| A crashed run is never summarised as "0 failed" | PASS |
| The verdict comes from the exit code, not from the log parsing | PASS |
| `.github` is not mistaken for an addon called `github` | PASS |
| Modules to install come from `git diff`, not from the plan | PASS |
| **Live, on-premise: `VALIDATION_ENABLED=true` with a 19.0 runtime and no role** | The task narrates exactly which two settings to add, then falls through to simulated |
| No regressions with validation off | 394 unit tests; smoke 54 / 43 / 31 / 27 / 50 | PASS |

**Reworded while here.** The simulated summary said "Validation passed: 3 step(s), simulated" — which
reads as a pass, and read worse still immediately after a line explaining the real run had been
skipped. It now says no repository code was executed and that this is not evidence the change works.

**Still not run.** A live Odoo test needs the Postgres role, which needs a superuser this session
does not have. `infrastructure/scripts/create-validation-role.sh` creates it and closes the
`CONNECT`-from-`PUBLIC` default in the same pass; it refuses cleanly when run without superuser,
which is what happened here.

---

## An aggregate that failed honestly (2026-08-31)

A background run of the five smoke suites reported **exit code 0 while 107 checks were failing**.
The cause was mundane: the loop running them discarded each exit code and only printed the summary
lines. The suites themselves were correct — they had failed because a restart had killed the API
underneath them — but the runner said nothing was wrong.

That is worse than having no aggregate. Every number in this document comes from a command, so a
command that lies about its own result undermines all of them.

`infrastructure/scripts/verify-all.sh` replaces it, and was checked in three states rather than one:

| State | Expected | Result |
| --- | --- | --- |
| Everything passing, `--fast` | exit 0 | PASS |
| One probe made to exit 3 | exit 1, naming the probe | PASS — "failed: push refusal" |
| Smoke suites unreachable | exit 1, not "skipped" | PASS — "failed: smoke suites (not run: API down)" |

The third is the one worth keeping: a suite that could not run has not passed, and counting it as
skipped beside a green total is exactly how a broken build looks healthy.
