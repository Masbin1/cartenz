# Module selection at project creation — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** A person creating a project with AI can either keep today's default
(every app of the edition installed) or pick a specific set of modules, the
way Odoo Online / Odoo.sh do at project creation.

**Architecture:** A read-only catalog endpoint enumerates real modules from the
host's addon paths (reusing the existing manifest parser). The existing
`CreateProjectWithAiDto.modules` field is validated against that catalog
instead of accepted as free text. Provisioning branches on whether a selection
was made: empty/omitted keeps today's synchronous full-template clone;
non-empty clones a new base-only template and runs a background `odoo-bin -i
<resolved modules>` install, reporting through the same `provisioningStatus`
column the platform already has, with `pending` reused as the in-progress
state (no new enum value). Dependency resolution and shell-argument sanitising
are pure functions, testable without a host.

**Tech Stack:** NestJS, Drizzle ORM (PostgreSQL), Jest (unit only, no
database in tests), Next.js App Router + Tailwind for the portal, bash for the
host-side scripts.

**Spec / mockup / ADR:** `docs/adr/ADR-056-module-selection-at-project-creation.md`
· `docs/adr/assets/ADR-056-module-selection-mockup.html`

## Global Constraints

- **British/South African spelling in prose, comments and user-facing copy:**
  "organisation", "licence" (noun), "catalogue" is optional (the repo already
  says "catalog" in ADR-045/051 — match that existing spelling for this
  feature rather than introducing a second spelling for the same noun).
- **Tests never touch a database.** Every `.spec.ts` in this repo is a pure
  unit test; anything needing a live stack is a host-side smoke test script,
  not Jest.
- **Comments explain why, not what.**
- **Migrations are hand-written files in `backend/drizzle/`, numbered in
  sequence** — never `drizzle-kit push`. Update `drizzle/meta/_journal.json`
  and the snapshot per the skill's documented recipe (three-part change, not
  just the `.sql`).
- **Enumerations live in `backend/src/core/enums.ts`.**
- **Audit event names live in `backend/src/core/audit/audit-events.ts`.**
- **The `-i` module list is never string-interpolated into a shell command.**
  It is validated, then passed as a single argument through the existing
  `CommandRunner`/`sudo -n` path, mirroring how every other provisioning
  argument in this codebase is handled (ADR-039's posture).
- **Run from `backend/`:** `npm test`, `npm run lint`, `npx tsc -p
  tsconfig.build.json --noCheck` (do not raise `--max-old-space-size` on this
  host — see the skill's OOM note; the working rebuild is documented there).
  Run from `frontend/`: `npx tsc --noEmit`.
- Root-gated steps (sudoers edit, template builds, systemd/script installs) are
  handed to the operator as an explicit numbered list at the end of the task
  that introduces them — do not block earlier tasks on them.

---

### Task 1: Module enumeration, as a pure function

Reuses the existing manifest parser; this task only adds the "walk a directory
and read every manifest" step and the category grouping, both pure and
testable with fixture directories.

**Files:**
- Create: `backend/src/modules/settings/odoo-module-catalog.ts`
- Create: `backend/src/modules/settings/odoo-module-catalog.spec.ts`

**Interfaces:**
- Consumes: `parseOdooManifest`, `OdooManifest` from
  `backend/src/agent/analysis/manifest-parser.ts`
- Produces:
  - `interface CatalogModule { technicalName: string; name: string; category: string | null; isApplication: boolean; depends: readonly string[] }`
  - `function enumerateModules(addonPaths: readonly string[]): Promise<CatalogModule[]>`
    — lists installable modules across one or more addon directories (base +
    enterprise, when edition is enterprise), de-duplicated by technical name,
    sorted by name. Mirrors `build-odoo-templates.sh`'s `list_modules()`
    filtering (skip dotfiles and `test_*`, require `__manifest__.py`,
    `installable !== false`).

- [x] **Step 1: Write the failing test**

Fixture-based: create a temp directory tree with two or three
`__manifest__.py` files (one application, one not, one with `installable:
False`) and assert `enumerateModules` returns the right set, correct
`isApplication`, correct `depends`, and excludes the non-installable one.

- [x] **Step 2: Implement `enumerateModules`**

- [x] **Step 3: Run `npm test -- odoo-module-catalog`** — 13 passed.

---

### Task 2: Dependency closure, as a pure function

**Files:**
- Add to: `backend/src/modules/settings/odoo-module-catalog.ts`
- Add to: `backend/src/modules/settings/odoo-module-catalog.spec.ts`

**Interfaces:**
- Produces:
  `function resolveDependencyClosure(selected: readonly string[], catalog: readonly CatalogModule[]): { resolved: string[]; unknown: string[] }`
  — `resolved` is the selected set plus every transitive `depends`, using the
  catalog's own `depends` field so a manifest with `depends: ['product',
  'mail']` pulls both, and their own dependencies in turn. `unknown` lists any
  selected name not present in the catalog (the caller turns this into a
  `BadRequestException`; the function itself just reports, since it has no
  concept of an HTTP error).

- [x] **Step 1: Write the failing test**

At minimum: a chain of three (`a` depends on `b` depends on `c`) resolves to
`{a,b,c}` from selecting only `a`; a name with a self-referential or circular
`depends` does not infinite-loop (track visited); an unknown selected name is
reported in `unknown` and excluded from `resolved`.

- [x] **Step 2: Implement `resolveDependencyClosure`** (BFS/DFS over `depends`
  with a visited set)

- [x] **Step 3: Run `npm test -- odoo-module-catalog`** — 13 passed.

---

### Task 3: Shell-argument sanitiser, as a pure function

Independent of Tasks 1–2 so it can be reviewed on its own: this is the
defence-in-depth floor the ADR requires regardless of the catalog check.

**Files:**
- Create: `backend/src/modules/projects/module-selection-sanitiser.ts`
- Create: `backend/src/modules/projects/module-selection-sanitiser.spec.ts`

**Interfaces:**
- Produces:
  `function sanitiseModuleNames(names: readonly string[]): string[]` — throws
  `BadRequestException` on any name failing `^[a-z][a-z0-9_]*$`, returns a
  de-duplicated, sorted array otherwise. Does not know about the catalog; the
  service layer runs the catalog check (Task 2) and this check both, and
  neither substitutes for the other.

- [x] **Step 1: Write the failing test** — reject `rm -rf`, reject
  `sale; DROP`, reject an empty string, reject a name starting with a digit or
  underscore, accept `sale_management`.
- [x] **Step 2: Implement** — implemented alongside a second export,
  `resolveSelectionOrThrow(selection, catalog)`, which does the sanitiser run
  *and* the Task 2 closure in one call, throwing one `BadRequestException` for
  either failure. Task 5 calls this rather than the two separately, so the
  ordering bug the plan's two-call shape allowed (resolve before sanitise) is
  not reachable from the service.
- [x] **Step 3: Run `npm test -- module-selection-sanitiser`** — 15 passed.

---

### Task 4: `GET /odoo-versions/:version/modules` endpoint

**Files:**
- Modify: `backend/src/modules/settings/odoo-versions.service.ts` (add a
  method that resolves the version's catalog row exactly the way
  `resolveRunnableConfig` already does, builds the addon path list for the
  requested edition, and calls `enumerateModules`)
- Modify: `backend/src/modules/settings/settings.controller.ts` (new route —
  confirm whether this belongs under `SettingsController` alongside the
  existing `odoo-versions` routes, or needs its own controller if the route
  must be reachable without the settings-admin guard; the module list is
  needed by every user creating a project, not only admins, so check the
  guard on the existing `odoo-versions` GET before deciding)
- Modify: `backend/src/modules/settings/dto/odoo-versions.dto.ts` (response
  DTO / query DTO for `?edition=`)

**Interfaces:**
- Route: `GET /odoo-versions/:version/modules?edition=community|enterprise`
- Response: `{ version: string; edition: string; modules: CatalogModule[] }`
- Falls back to the organisation-wide base path (ADR-045 §1) when the version
  has no active catalog row, exactly as project creation itself does — do not
  404 a version that would still provision successfully.

- [x] **Step 1: Extend `odoo-versions.service.spec.ts`** with a case for the
  new method, mocking the filesystem (or pointing at a fixture directory the
  way Task 1's test does).
- [x] **Step 2: Implement the service method and the route.**
- [x] **Step 3: Manual host check** (not a unit test — this is the one place
  worth hitting the real filesystem):
  `curl -s $API/odoo-versions/19.0/modules?edition=enterprise | jq '.modules | length'`
  and compare against `find /opt/odoo/enterprise /opt/odoo/odoo-server/addons
  -maxdepth 1 -name __manifest__.py | wc -l`.

  **Correction after running it:** that `find` returns 0 — manifests sit one
  level further down (`<addonPath>/<module>/__manifest__.py`), so `maxdepth 1`
  never sees one. Verified instead by calling `enumerateModules` against the
  real paths in a throwaway spec: 638 community directories → 1336 modules for
  community+enterprise, `sale_management` resolved with
  `depends: ['sale', 'digest']`. The endpoint itself is not curl-checked yet
  because the backend is not running in this session — that is Task 12's job.

---

### Task 5: Validate `modules` on the create-with-AI DTO against the catalog

**Files:**
- Modify: `backend/src/modules/projects/dto/project.dto.ts` (no shape change —
  `modules?: string[]` already exists; this task is about where it's
  validated, not the field itself)
- Modify: `backend/src/modules/projects/projects.service.ts` (in
  `createAiProject`, before calling `provisionAiProject`: if `dto.modules` is
  non-empty, call `OdooVersionsService`'s enumeration for the project's
  version/edition, run `resolveDependencyClosure` (Task 2), and throw
  `BadRequestException` listing any `unknown` names)

**Interfaces:**
- Consumes: `resolveDependencyClosure` (Task 2), `sanitiseModuleNames`
  (Task 3)
- The resolved (post-closure) module list — not the raw checked boxes — is
  what gets passed to `ProjectProvisioningService.provision` in Task 7. Store
  it as a new field on the provisioning input rather than re-deriving it
  later.

- [x] **Step 1: Extend `projects.service.spec.ts`** (or the closest existing
  spec covering `createAiProject`) — **deviation:** no `projects.service.spec.ts`
  exists, and this service's constructor takes 15 dependencies, which this
  repo's specs never mock (its neighbours test extracted pure functions
  instead). The validation was therefore extracted into
  `resolveSelectionOrThrow` and tested there, matching the repo's convention
  rather than introducing a 15-mock spec nothing else in the codebase does.
  Covered: unknown name rejected before provisioning; valid selection returns
  the resolved closure; shell-unsafe name rejected. Not yet covered: the
  service-level wiring itself (that `createAiProject` calls it) — see Task 12. unknown module name is rejected
  before provisioning starts; a valid selection reaches provisioning with the
  closure resolved (assert the array passed to the mocked provisioning
  service, not just that no error was thrown).
- [x] **Step 2: Implement the validation call.**
- [x] **Step 3: Run `npm test -- projects.service`**

---

### Task 6: Base-only template — host script (operator-run, not platform code)

This produces the artefact Task 7 clones. It is root-gated and does not block
Tasks 1–5, 8–11, but Task 7's end-to-end verification needs it to exist.

**Files:**
- Modify: `infrastructure/provisioning/build-odoo-templates.sh` — add a third
  template per edition, `cartenz_tpl_<ver>_<com|ent>_base`, built the same way
  the existing full templates are but with `-i base` instead of the full
  module list (i.e. today's pre-ADR-045 behaviour, kept as an explicit named
  artefact instead of being retired). Do not change the two existing full
  templates' build steps.
- Modify: `docs/guides/odoo-version-templates.md` — document the third
  template alongside the existing two, and when an operator needs to rebuild
  it (same triggers as the full templates: a version upgrade, an addon path
  change).

- [x] **Step 1: Extend the script** with a third `build_template` call:
  `build_template "community" "cartenz_tpl_${VER_TAG}_com_base" --base-only`
  (thread a flag through `build_template` that swaps the `list_modules`
  call for a literal `"base"`, rather than duplicating the function).
- [x] **Step 2: Update the usage/echo text** at the end of the script to
  mention the third template.
- [ ] **Step 3: Hand the operator this exact root step** (do not run it from
  application code — it is a multi-minute Odoo install, same posture as the
  existing template builds):

  ```
  sudo /opt/cartenz/infrastructure/provisioning/build-odoo-templates.sh \
    19.0 /opt/odoo/odoo-server /opt/odoo/venv/bin/python /opt/odoo/enterprise
  ```

  Then verify: `psql "$DATABASE_URL" -c "select datname,
  pg_size_pretty(pg_database_size(datname)) from pg_database where datname
  like 'cartenz_tpl_19_0%'"` — the `_base` rows should be materially smaller
  than the full ones (base module only vs. hundreds of modules).

---

### Task 7: `create-project-db.sh` — selective install path

**Files:**
- Modify: `infrastructure/provisioning/create-project-db.sh` — accept an
  optional module list argument; when present, clone the `_base` template
  (Task 6) instead of the full one, then run the `odoo-bin -i <modules>
  --without-demo=all --stop-after-init` step already used for the unversioned
  fallback (ADR-045 §1), generalised from the literal `base` to the given list.
- Modify: `docs/guides/odoo-version-templates.md` (usage line for the new
  argument)

**Interfaces:**
- New usage:
  `create-project-db.sh <name> <community|enterprise> <version> [url] [region] [modules_csv]`
  — a 6th, still-optional positional argument, keeping every existing call
  shape valid (mirrors how `[region]` was added as ADR-051's own optional 5th
  argument).
- When `modules_csv` is given: ignore the region-scoped full-install template
  entirely and use `cartenz_tpl_<ver>_<edition>_base`; error clearly if that
  template does not exist (this is a real operator-facing error message, not a
  silent fallback to the full template, per the ADR's "provisioning must
  surface that failure" consequence).

- **This script is not where the new argument arrives from.** It is
  `create_project` / `create_project_enterprise` (the host scripts) that call
  `create-project-db.sh` — currently as a fixed 5-argument invocation, e.g.
  `"${SCRIPTS_DIR}/create-project-db.sh" "${PROJECT_NAME}" community
  "${VERSION}" "https://${DOMAIN}" "${REGION}"`. Because the scripts cannot
  pass a module list to a script they already invoke with a fixed shape, the
  module list has to reach them a different way: the platform appends it as
  the script's own further trailing argument (Task 8's extended
  `assertProvisioningInvocation`), and `create_project[_enterprise]` must
  themselves grow an optional 5th (community) / 5th (enterprise) positional
  argument which they forward to `create-project-db.sh` as its 6th. So this
  task actually touches **three** files: `create-project-db.sh` (accept and
  act on it), and `infrastructure/provisioning/host/create_project` +
  `create_project_enterprise` (accept and forward it). Note that the host
  scripts installed at `/opt/odoo/scripts/` are the operator's copies —
  editing the repo copies is not enough; Step 4 below is the reinstall.

- [x] **Step 1: Read the current script fully** before editing — it already
  branches on region-vs-no-region for template selection (ADR-051 §Template
  selection), and the new branch must not disturb that logic, only add a third
  case ahead of it.
- [x] **Step 2: Implement the modules-csv branch**, including running
  `odoo-bin` as the `odoo` OS user over the local socket the way
  `build-odoo-templates.sh` already does (peer auth, no `db_password` — copy
  that pattern, don't reinvent it).
- [ ] **Step 3: Hand the operator a manual dry run** on a throwaway project
  name (per the skill's "not dry-runnable" pitfall — this creates a real
  instance, clean it up after):
  ```
  sudo /opt/odoo/scripts/create_project throwaway-modtest <port> 19.0 <url> indonesia sale_management,stock
  ```
  Verify `ir_module_module` on the resulting database shows exactly
  `sale_management`, `stock`, their resolved dependencies, and `base` —
  nothing else installed. Tear down per the skill's standard throwaway
  checklist.
- [ ] **Step 4: Hand the operator the reinstall step**, since
  `/opt/odoo/scripts/create_project[_enterprise]` are host copies, not
  symlinks to the repo (per the skill's "arg-count drift breaks creation"
  note — this exact class of drift bit the platform once already):
  ```
  sudo install -m 0755 infrastructure/provisioning/host/create_project /opt/odoo/scripts/create_project
  sudo install -m 0755 infrastructure/provisioning/host/create_project_enterprise /opt/odoo/scripts/create_project_enterprise
  sudo install -m 0755 infrastructure/provisioning/create-project-db.sh /opt/odoo/scripts/create-project-db.sh
  ```
  Re-run Step 3's dry run only after this lands — testing against the
  un-reinstalled host copies would pass against code that isn't actually
  live, exactly the trap the platform skill's build-freshness check exists
  to catch.

---

### Task 8: `assertProvisioningInvocation` accepts the modules argument

**Files:**
- Modify: `backend/src/core/process/command-runner.service.ts`
- Modify: `backend/src/core/process/command-runner.spec.ts`

**Interfaces:**
- `assertProvisioningInvocation` currently validates the fixed argument shapes
  for `create_project`/`create_project_enterprise` (ADR-039, extended by
  ADR-045's optional version argument). Add a further-optional trailing
  argument: a comma-separated list matching `^[a-z][a-z0-9_]*(,[a-z][a-z0-9_]*)*$`
  (the same floor as Task 3's sanitiser — this is the second, independent gate
  the ADR calls for, so don't skip it because Task 3 already checked; a bug in
  one must not be the only thing standing between a bad string and `sudo`).

- [x] **Step 1: Extend the spec** with: the five-argument shape (existing) still
  passes; a six-argument shape with a valid module CSV passes; a six-argument
  shape with a shell metacharacter in the CSV is refused; a malformed module
  name (leading digit, uppercase) is refused.
- [x] **Step 2: Implement the extended shape check.**
- [x] **Step 3: Run `npm test -- command-runner`**

---

### Task 9: Async provisioning path in `ProjectProvisioningService`

The core behavioural change: a selective request returns immediately with a
pending status, and the real work happens off the request thread.

**Files:**
- Modify: `backend/src/modules/projects/project-provisioning.service.ts`
- Create: `backend/src/modules/projects/project-provisioning.service.spec.ts`
  (checked: this file does not exist today — unlike its neighbours
  `project-deployment.spec.ts` and `preview-plan.spec.ts`, provisioning has no
  spec at all, so this task creates one rather than extending one)
- Modify: `backend/src/modules/projects/projects.service.ts` (the
  `provisionAiProject` call site — Task 5 already touched the validation half
  of this method)
- Reuse: `PROJECT_PROVISIONING_STATUSES` from `backend/src/core/enums.ts` —
  **no new enum value**; `pending` already exists and is unused by the
  synchronous path today (it goes `none → provisioned` or `none → failed`
  directly), so it becomes the selective path's in-progress state rather than
  inventing a fifth status the frontend and every existing status-switch would
  need to learn.

**Interfaces:**
- `provision()` gains an optional `modules?: readonly string[]` input field.
- When `modules` is empty/absent: **completely unchanged** control flow —
  same synchronous `sudo` call, same immediate `provisioned`/`failed` result.
  This is the task most likely to accidentally regress the default path, so
  the existing provisioning tests must still pass unmodified.
- When `modules` is present: the project row is created with
  `provisioningStatus: 'pending'` and the method returns immediately
  (`provisioned: false` is not right either — introduce a return variant the
  caller maps to "creation succeeded, provisioning is running", so `findOne`
  and the creation response both read `pending` correctly rather than reading
  a `provisioned: false` as an outright failure).

  **Correction from an earlier draft of this plan:** the ephemeral preview
  service (ADR-052) was checked as a possible precedent for "fire a root-run
  step from an HTTP handler and let it run in the background" and turns out
  NOT to be one — `ProjectPreviewController.start()` calls
  `this.previews.start(...)` and that method `await`s the `sudo` call directly
  in the same request, relying only on a long `timeoutMs`
  (`this.config.process.maxTimeoutMs`) to survive a multi-minute build. It is
  a slow synchronous call, not a background job, and copying its shape here
  would reproduce exactly the timeout risk this task exists to avoid.

  The platform's real precedent for background work is the existing BullMQ
  queue (`backend/src/core/redis/redis.constants.ts`'s `AGENT_TASK_QUEUE`,
  driven by `backend/src/worker.ts`, added-to via
  `QueueAgentOrchestrator.start()`/`.resume()` in
  `backend/src/agent/orchestration/queue-agent-orchestrator.ts`). Follow that
  shape: add a job name (e.g. `AGENT_JOB_PROVISION_MODULES` alongside
  `AGENT_JOB_EXECUTE`/`AGENT_JOB_RESUME` in `redis.constants.ts`, or a small
  dedicated queue if mixing provisioning jobs into the agent-task queue reads
  wrong — decide by whether `worker.ts`'s single job processor should grow a
  second job-name branch or a second `Worker` should be started for a second
  queue; either is legitimate, but pick one and say why in the PR rather than
  leaving both attempted), enqueue it from `ProjectProvisioningService` with
  the resolved module list as job data, and let a worker-side handler run the
  actual `sudo -n create-project-db.sh ...` call with the existing
  `maxTimeoutMs`-guarded `CommandRunner` — a worker process has no HTTP
  request deadline to race against, which is the actual property this task
  needs, not merely "not awaited".
- On completion, update `provisioningStatus` to `provisioned` (with port/url,
  same as today) or `failed` (with the error captured on the row, same
  `summariseTail` pattern already used).

- [x] **Step 1: Write `project-provisioning.service.spec.ts` from scratch** —
  assert the unchanged path first (regression guard), then the new path:
  calling `provision` with `modules` set returns immediately with a pending
  marker without waiting for the mocked `sudo`/queue call to resolve; the row
  is updated to `provisioned`/`failed` once the background job settles (use a
  controllable mock/deferred promise or a mocked queue `.add()` to assert both
  the immediate return and the eventual update).
- [x] **Step 2: Implement.** Keep the synchronous branch's code path
  textually separate from the async branch (an `if (modules?.length) { ... }
  else { /* existing code, untouched */ }`) rather than threading a boolean
  through the existing function — this is what keeps the regression risk to
  the diff's shape, not just its behaviour.
- [x] **Step 3: Run `npm test -- project-provisioning`**

---

### Task 10: Portal — Modules section in `CreateWithAiForm`

**Files:**
- Modify: `frontend/app/projects/new/page.tsx`
- Modify: `frontend/lib/api.ts` (or wherever `api.projects.createWithAi` and
  friends live — add `api.odooVersions.modules(version, edition)`)
- Create: `frontend/components/projects/module-picker.tsx`

**Interfaces:**
- `<ModulePicker version edition value={selected} onChange={setSelected} />`
  — fetches the catalog on mount and whenever `version`/`edition` changes
  (matches the mockup's stated refetch behaviour), renders the search box,
  category filter, "Apps only" toggle, scrollable checkbox list, footer count,
  and the resolved-dependency panel (calling Task 2's `resolveDependencyClosure`
  logic client-side against the fetched catalog — no extra round-trip needed
  since the whole catalog is already in hand).
- `CreateWithAiForm` gains the two-radio "Install everything" / "Choose what
  to install" section per the ADR §6 layout, submitting `modules: undefined`
  for the first and `modules: selectedTechnicalNames` for the second.
- Match `docs/adr/assets/ADR-056-module-selection-mockup.html` for the visual
  shape, but build it with the portal's actual components/classes (`panel`,
  `field-input`, `field-label`, etc. from `globals.css`) rather than the
  mockup's inline styles — the mockup is a reference, not a source to copy
  markup from.

- [x] **Step 1: `npx tsc --noEmit`** clean before starting (baseline).
- [x] **Step 2: Build `ModulePicker`** as an isolated component first, with a
  hand-written fixture array so it can be eyeballed before wiring the real
  fetch.
- [x] **Step 3: Wire it into `CreateWithAiForm`** behind the radio, and wire
  `api.odooVersions.modules`.
- [x] **Step 4: `npx tsc --noEmit`** again; fix any type errors before moving
  on.
- [x] **Step 5: Build the portal** per the skill's documented recipe
  (`infrastructure/scripts/build-portal.sh`, never by hand) and visually check
  against the mockup on a real page load — this is a UI task, so a clean
  typecheck is not suficient proof it looks right.

---

### Task 11: Portal — provisioning status and installed-modules panel

**Files:**
- Modify: `frontend/app/projects/[projectId]/page.tsx`
- Create or modify: a status component under `frontend/components/projects/`
  for the three-step provisioning list (ADR §7.1)
- Create: `frontend/components/projects/installed-modules-panel.tsx` (ADR §7.2)
- Modify: `backend/src/modules/projects/projects.controller.ts` /
  `projects.service.ts` — a read endpoint for installed modules. This needs
  a way to query the provisioned instance's own database for
  `ir_module_module` where `state = 'installed'`; check whether an existing
  connection/credential path already supports a scoped read like this (the
  same boundary that keeps the platform from touching customer data directly,
  per ADR-051 §4) before adding a new one — this may turn out to need its own
  small ADR addendum if no such read path exists yet. Flag this to the
  operator as a design question rather than guessing a shape.

- [x] **Step 1: Confirm the data-access shape** for the installed-modules
  read-back with the operator before writing code — this is the one part of
  the ADR not fully pinned down (see the note in ADR §7.2 about reading back
  from the instance).
- [x] **Step 2: Implement the provisioning status view**, polling the existing
  project-status endpoint at whatever interval the task-progress UI already
  uses (reuse, don't invent a new poll interval).
- [x] **Step 3: Implement the installed-modules panel** once Step 1's shape is
  settled.
- [x] **Step 4: `npx tsc --noEmit`**, then build and visually verify against
  the mockup's second screen.

---

### Task 12: End-to-end verification

Not a code task — the checklist that proves Tasks 1–11 actually work together,
run after Task 6's template exists on the host.

- [ ] `GET /odoo-versions/19.0/modules?edition=enterprise` returns a list
  matching a manual `find` count (Task 4's manual check, re-run here as
  confirmation the shipped code still matches).
- [ ] Default path regression: create a project with no module selection;
  confirm identical behaviour to before this feature shipped (instant,
  `provisioned`, full app count) — this is the check most worth automating
  into the existing smoke-test script rather than doing by hand every time.
- [ ] Selective path: create a project selecting 2–3 modules with known
  dependencies; confirm the portal shows the provisioning screen, then
  transitions to ready; confirm `ir_module_module` on the resulting instance
  matches exactly the resolved closure.
- [ ] Failure path: submit a selection that will fail install (e.g. reference
  a module whose dependency is missing from the host, if such a case can be
  constructed safely) and confirm the project row lands on `failed` with a
  readable reason, not stuck on `pending` forever.
- [ ] Clean up every throwaway project/instance created during this
  verification per the skill's standard teardown checklist.

## Deviations found while executing Tasks 6–11

Recorded here rather than edited into the steps above, so the plan still reads
as what was intended and this reads as what happened.

1. **Task 6 flag name.** Implemented as a positional `base_only` third argument
   (`build_template "community" "cartenz_tpl_${VER_TAG}_com_base" true`), not a
   `--base-only` flag. The function takes positionals throughout; a flag would
   have been the only option-parsing in the file.

2. **Task 7 Step 4 was based on a wrong premise, then verified.** The plan warns
   that `/opt/odoo/scripts/` copies are the operator's and that editing the repo
   is not enough. Confirmed by `diff`: `infrastructure/provisioning/host/create_project`
   is byte-identical to `/opt/odoo/scripts/create_project`, so the `host/` copies
   ARE the production scripts. (The top-level
   `infrastructure/provisioning/create_project` is a separate, older reference
   implementation, 922 lines different — it is NOT what the host runs and was
   left untouched.) The reinstall step remains open: it is root-gated.

3. **Task 9's shape changed three times during implementation**, each for a
   reason the plan could not have known:

   - The queue lived in `ProjectProvisioningService`'s constructor at first.
     A `new Queue()` there opens a real Redis connection, so the spec could
     never exit. Extracted to `ProjectProvisioningQueue` (its own injectable),
     mirroring the existing `QueueAgentOrchestrator` pattern, so the spec
     injects a stub with no connection. This is why the spec passes now.
   - The job carries the allocated `port`, not just the modules: `provision()`
     allocates a port for the pending row, and a worker-side re-allocation would
     hand out a different one than the row already claims.
   - **Enqueue moved from `provision()` to `ProjectsService.createAiProject`.**
     The job payload needs a real `projectId`, and `provision()` is called
     *before* the row is inserted (its comment says so). Enqueuing there would
     have handed the worker an empty id. The enqueue now happens after the
     transaction commits, and the pending path returns early — skipping the
     GitHub step, which needs a directory that does not exist yet.
   - Consequently `completeSelectiveProvisioning` (in `ProjectsService`) owns the
     whole worker-side tail — sealing the master password, git-initting
     `addons/`, connecting GitHub — because all of it needs a directory that
     only exists after the worker's script call. The synchronous path's tail is
     duplicated, deliberately: the two run in different worlds (HTTP request vs
     worker) and sharing would mean threading a boolean through every branch.

4. **Task 10: `api.projects.createWithAi` already accepted `modules?: string[]`**
   before this task started, so no `api.ts` change was needed for the POST. The
   new method is `api.settings.odooVersionModules(version, edition)` — note
   `api.settings`, not `api.odooVersions`; the portal groups it under settings.

5. **Task 11 Step 1 is still open, and this is the plan working as written.**
   No read path to a provisioned instance's own database exists anywhere in the
   platform (verified: zero `ir_module_module` references in `backend/src`).
   Building one means a new direct-database access boundary, which is a design
   decision for the operator, not something to guess. The provisioning status
   view (Step 2) shipped; the installed-modules panel (Step 3) is not built.

6. **Poll interval (Task 11 Step 2).** The plan says to reuse the existing
   interval; there is no polling interval elsewhere in the portal — task
   progress uses an SSE stream (`lib/use-task-stream.ts`). A new 3-second
   `setInterval` was added to the project detail page, active only while the
   status is `pending`.

## Task 11 Step 1 — resolved (previously open)

The operator chose option A: a fourth root-run script, mirroring
grant-addons-write.sh / backup-project.sh in every respect —
`infrastructure/provisioning/list-installed-modules.sh` takes one project name,
reads the database name from that project's own `odoo.conf` (not derived from
the name), and runs exactly one fixed query, `SELECT name, state FROM
ir_module_module ORDER BY name`, against exactly that database. No argument
can select a different table, database, or turn the read into a write.

Reached the platform through the same two independent gates as every other
privileged script: the sudoers `Cmnd_Alias` in
`infrastructure/provisioning/99-linkederp-provisioning` (root action, not run
by this session — see below) and a new branch in `assertProvisioningInvocation`
(`command-runner.service.ts`), with its own TDD test group, following Task 8's
floor exactly. `ProjectModulesService` wraps it the way `ProjectBackupService`
wraps the backup script, except read-only: no table, no audit event, no cache
— a stale list after an install would be worse than a slower read.

The option not taken (B, reusing `OdooOnlineClient`'s JSON-RPC pattern) would
have needed a place to store an admin login per on-premise project, which does
not exist today; A reuses infrastructure that was already there.
