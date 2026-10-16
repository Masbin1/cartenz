# ADR-073: Fit-gap database setup at project creation

- Status: Proposed
- Date: 16 October 2026
- Milestone: Phase 5 (connected-server estate)

Builds on ADR-039 (provisioned instance), ADR-045 (version/edition template
catalog), ADR-051 (region in template selection), ADR-056 (module selection
and recommendation at project creation).

## Context

ADR-056 closed the gap between "the brief says what the project needs" and
"the right *modules* are installed": the model reads the brief, proposes
technical names filtered to the real catalogue, the person reviews them, and
`create-project-db.sh` installs exactly that set.

It stops at the module boundary. A freshly provisioned project — selective or
full-install — is Odoo with nothing configured for the business described in
the brief: no units of measure, no product attributes, no warehouse routes, no
work centers, no localisation beyond the template's default company. Every one
of those is ordinary first-day consultant work, done by hand in the Odoo UI
after the instance exists.

The operator wants that first day folded into project creation: brief in,
modules chosen **and** the database pre-configured for what Odoo can actually
express, with whatever the brief needs that Odoo cannot express out of the box
turned into visible, actionable requirements rather than silently dropped.

Two things make this harder than ADR-056's module recommendation:

- **Module recommendation chooses from a closed set of ~700 names and writes
  nothing** — a wrong suggestion costs a re-tick in the picker. Database setup
  **writes records**, with root privilege, into a client's database, from a
  prompt that is untrusted input (ADR-020's AI data boundary). A wrong plan
  here is not a cosmetic mistake.
- **"What Odoo can configure" is not one closed list.** It is a toggle on
  `res.config.settings` on one version/edition, a `Selection` value on
  `stock.warehouse`, a `product.attribute` plus its values, a `uom.uom`,
  a `mrp.workcenter`. Each is a different model, a different set of legal
  values, and in one documented case (`group_show_uom_price`, present on
  `product.res_config_settings` in 20.0 and absent in 19.0) a different set
  *per version*.

ADR-039's `CommandRunner` chokepoint and ADR-020's AI boundary both already
answer the shape of problem this is: an AI output must never be code that
runs with privilege, and a root-run script must never accept an argument that
can steer what it does beyond a fixed, narrow shape. This ADR applies both
unchanged; it does not loosen either.

## Decision

### 1. The brief becomes a fit-gap document, not only a module list

`POST /settings/odoo-versions/:version/modules/recommend` (ADR-056) is joined
by a second call in the same request cycle — same brief, same catalogue
context — that returns three things instead of one:

```
{
  modules:        [...]                 // unchanged, ADR-056
  configuration:  ConfigurationItem[]    // new — what Odoo can do out of the box
  gaps:           GapItem[]              // new — what it cannot
}
```

- **`configuration`**: settings toggles, UoM categories/units, warehouse route
  steps, product attributes and values, work centers, company/localisation
  fields — each tied to the exact field or model it will set, never free text.
- **`gaps`**: the parts of the brief no combination of the above can express
  (cubic-volume auto-calculation, yield/shrinkage tracking, a cut-optimisation
  routine, a grading scale that changes price) — free text plus the brief
  excerpt it came from, with no model attached, because there is nothing in
  the catalogue to attach it to.

This is the worked example from the discussion that produced this ADR (wood
production, varied sizes): `mrp`, `stock`, `sale_management` as modules;
variants for thickness/width/length, an m³ unit of measure, multi-step warehouses
and three work centers (Sawmill, Kiln Dryer, Planer) as configuration; m³
auto-calculation from variant dimensions, yield/shrinkage, and cut-pattern
optimisation as gaps.

### 2. The model chooses only from a menu built from the live instance, never from imagination

The model is never asked "what settings does this project need" in the
abstract — it is asked to **select from an enumerated menu**, the same
discipline `RECOMMENDATION_SCHEMA` + `keepCatalogued` already apply to module
names (`backend/src/modules/settings/odoo-module-recommendation.ts`).

A new `OdooSetupCatalog` (`backend/src/modules/settings/odoo-setup-catalog.ts`)
builds that menu **per version/edition**, read live, the same way
`enumerateModules` reads manifests rather than hand-maintaining a list:

- **Settings toggles**: for each module recommended or selected, read its
  `res_config_settings.py` and collect every `fields.Boolean` named
  `group_*` (an Odoo convention: these gate a feature behind a `res.groups`
  record and are always safe to flip through `res.config.settings`, which is
  the same object the Settings screen itself writes through) together with
  its `string=`/label and the module it came from. Builds the "toggle" menu
  entirely from source, so a 20.0-only field such as `group_show_uom_price`
  (`product/models/res_config_settings.py`) never appears on a 19.0 project
  and a 19.0-only field never appears on 20.0 — the drift ADR-056 already
  worried about for module names, now handled for settings the same way.
- **Fixed-shape records**: a short, hand-written (not derived from a
  manifest) list of model/field combinations whose *shape* is read from the
  model's own field metadata at runtime rather than hard-coded values. There
  is no `uom.category` model on this host's 19.0/20.0 (verified against
  `addons/uom/models/uom_uom.py`): a unit is a `uom.uom` row with a
  `relative_uom_id` pointing at the reference unit in its group and a
  `relative_factor` against it, so "add an m³ unit" means creating one
  `uom.uom` row referencing an existing reference unit (`product_uom_meter`,
  `product_uom_litre`, already seeded by `uom`'s own data), never a new
  category. Also in scope: `stock.warehouse` (`reception_steps`,
  `delivery_steps`, and, when `mrp` is
  selected, `manufacture_steps` — each a `Selection` whose legal values are
  read from the field itself, so a value the model invents is impossible to
  pass validation, not merely unlikely to), `product.attribute` /
  `product.attribute.value` (name, values, `create_variant`),
  `product.category` (name, parent), `mrp.workcenter` (name, code,
  `costs_hour`), `res.lang` installation (one call to the existing
  `base.language_install` wizard, not a bespoke insert).
- **Company/localisation fields**: `res.company.name`, `currency_id` (from
  the brief's stated currency, validated against `res.currency`),
  `res.lang` default. Deliberately **not** included: NPWP, registered
  address, bank account — ADR-020 already marks the brief as untrusted input,
  and these are exactly the fields a consultant verifies against a legal
  document, not a paragraph of prose. The plan leaves them as a `gap`-shaped
  "needs input" item instead of guessing, which is the same posture the
  existing recommendation endpoint takes toward an unknown module name:
  refuse to invent, surface the absence.

`catalogueForPrompt`'s pattern repeats: the catalogue is serialised compactly
for the prompt, the model's structured output is filtered back against it
(`keepCataloguedSettings`/`keepCataloguedRecords`, mirroring `keepCatalogued`),
and anything the model names that is not on the menu is dropped before a
person ever sees it — not flagged, dropped, the same severity ADR-056 already
applies to an invented module name.

### 3. The plan is JSON data, never generated code

The model's output for `configuration` is one JSON document per project — a
list of `{ step: 'company' | 'setting' | 'record', model, field/values,
reason }` entries, each already validated against the catalog in step 2. No
part of this feature asks a model to write Python, a shell command, or an ORM
call, and no part of the pipeline executes model-authored source. This is the
same boundary `python3` crosses today only for the operator's own, reviewed
validation runtime (ADR-027) and never for AI-authored content — ADR-073
introduces no new way for a prompt to become code.

What executes the plan is **one fixed, human-written applier**, reviewed once
like every other provisioning script, not generated per project:
`infrastructure/provisioning/apply-db-setup.sh`. It takes the same
`<project-name>`-only shape `list-installed-modules.sh` and
`backup-project.sh` already take (narrowed by `assertProvisioningInvocation`,
granted by the same `99-linkederp-provisioning` sudoers `Cmnd_Alias`), and
reads the plan from **stdin** — the same convention `pull-project.sh` already
uses to keep a credential out of argv — never as a shell argument, so there is
no argument vector for a plan to escape through.

Internally, the script pipes that JSON into `odoo-bin shell -d <db> --no-http`
feeding a **fixed** (not model-authored) Python driver that:

1. Parses the JSON once, re-validates every model/field name against the
   in-process `_fields` of the live registry (defence in depth: even if the
   backend's catalog check were ever bypassed, the ORM call still refuses an
   unknown field rather than raising an `AttributeError` mid-run), and refuses
   the whole plan if anything fails that check — no partial application from a
   malformed plan.
2. Opens one savepoint per entry (`cr.savepoint()` — the same primitive
   `tests/common.py` and several upgrade scripts already use), applies it
   (`res.config.settings.create({...}).execute()` for a setting,
   `search_or_create`-shaped idempotent `create`/`write` for a record), and
   rolls back only that savepoint on failure — one bad entry cannot take the
   rest of the plan with it.
3. Prints one JSON report line per entry (`applied` / `skipped` with a reason
   / `failed` with the ORM's own error) to stdout, and commits once at the end
   if at least one entry applied.

Nothing above is new privilege. It is the same `sudo -n <configured-script>
<project-name>` shape every other ADR-039 script already has, running against
the one project database the script resolves exactly the way
`list-installed-modules.sh` does today (read `db_name` from that project's own
`odoo.conf` — never from an argument).

### 4. Review happens before Create, exactly like module selection

`docs/adr/assets/ADR-073-fit-gap-setup-mockup.html` is the review artifact for
this section — a standalone rendering built the same way ADR-056's mockup is,
against the portal's real palette, not production code.

The "Create with AI" form gains one more section after Modules (ADR-056's
mockup), structured as three tabs rather than one list, because the three
kinds of item need different actions:

```
┌─ What Cartenz will set up ──────────────────────────────────┐
│  [ Modules (4) ]  [ Configuration (9) ]  [ Needs attention (3) ] │
│                                                               │
│  ── Configuration tab ──                                     │
│  [x] Enable product variants (group_product_variant)         │
│  [x] Unit of measure: m³ (volume, relative to litre)          │
│  [x] Warehouse: Manufacture (2 steps) — pick then manufacture │
│  [x] Work centers: Sawmill, Kiln Dryer, Planer                │
│  [ ] Company currency: IDR            [change]                │
│  Each row: checkbox + one-line reason tied to the brief.      │
│  Unchecking removes it from the plan; nothing here is forced. │
│                                                               │
│  ── Needs attention tab ──                                    │
│  • Auto-calculate m³ from length×width×thickness              │
│    "various sizes, should compute volume" — brief, para 2     │
│  • Yield/shrinkage tracking from log to finished board        │
│  • Grading (A/B/C) affecting price                             │
│  These become requirements on the project specification; a     │
│  task can be opened against any of them once the project       │
│  exists. Nothing here blocks Create.                           │
└───────────────────────────────────────────────────────────────┘
                    [ Create project and specification ]
```

Unchecking a configuration item removes it from the plan sent at creation —
the same "ticked boxes, not a forced outcome" rule ADR-056 already applies to
modules. Nothing in the Needs-attention tab is actionable at creation time; it
only shapes what lands in the specification (§6).

### 5. Setup runs as a step in the same provisioning job, after modules — not a separate feature

Database setup has no reason to be its own job: it needs the instance's
database to exist and its modules installed first, and nothing else depends
on it. It is appended as a fourth step inside the provisioning worker's
existing sequence —

```
clone/create DB → install modules → *apply DB setup plan* → start service + HTTPS
```

— reusing the asynchronous shape ADR-056 §4 already established (status
written onto the project row, polled by the portal) rather than introducing a
second progress mechanism. It runs through the same `sudo` call pattern as
`list-installed-modules.sh`/`backup-project.sh`, with `timeoutMs:
maxTimeoutMs` the way `runProvisioningScript` already sets it — `odoo-bin
shell` against an already-installed instance applying a few dozen records is
materially faster than the module install step that just ran before it, so
the existing 20-minute ceiling (`PROCESS_MAX_TIMEOUT_MS=1200000` on this host)
is more than enough headroom, not a new risk.

**A setup failure never fails the project.** The instance is real and
running; a setup plan is a bonus on top of it. The project's provisioning
status stays `provisioned`; a new, separate `dbSetupStatus` column
(`none | pending | applied | partial | failed`) and `dbSetupReport` (the
driver's own per-entry JSON, kept verbatim — the same "the script's own words
are the useful message" posture `summariseTail` already applies) carry the
outcome. `partial` is a real, expected state: some entries applied, some
failed or were skipped, same as a partially successful module install can
leave some modules at `state != 'installed'`. The project page gets a
"Run setup again" action calling the same script — safe to repeat, because
every record-creating step above is written idempotent (search-before-create
on a natural key: UoM name, attribute name, warehouse code, work center code)
rather than append-only.

### 6. Gaps become requirements on the specification, not a side list

`ProjectSpecificationRequirement` (`project-specification.ts`) gains one
field: `kind: 'functional' | 'configuration_gap'`, defaulted to `'functional'`
so every existing requirement (today's free-text brief items) is unaffected.
A gap accepted on the review screen is appended to `dto.requirements` before
`buildProjectSpecification` runs, numbered `REQ-00N` exactly like any other
requirement — gaps are not a separate store, they are requirements whose
origin is recorded.

This is deliberately the full extent of the "becomes a task" step in this
ADR. A gap requirement is visible on the project page next to every other
requirement, with its own badge, and a task can be opened against it through
the task flow that already exists for any requirement — no new task-creation
mechanism, no auto-dispatch to an agent. Phase 3 (§8) is what turns "open a
task against REQ-004" into one click that pre-fills the task prompt with the
requirement text and the configuration plan that was actually applied, so the
agent's custom module lands on top of a database it can already query
correctly — not a change to task creation itself.

### 7. What is deliberately out of scope here

- **No arbitrary SQL, no arbitrary ORM call.** The applier's fixed driver
  knows exactly four operations (`res.config.settings`, a short fixed list of
  record models, the language-install wizard, company field writes) and
  nothing else; extending the menu means extending the driver and its
  whitelist in a reviewed change, the same way `GUARDED_EXECUTABLES` or
  `ALLOWED_EXECUTABLES` are extended today — never a runtime decision a brief
  can make.
- **No BoM/routing quantities, no pricing, no taxes, no payment terms in
  phase 1.** A brief rarely states "0.08 m³ of raw log per finished board" in
  a form precise enough to write a `mrp.bom.line` correctly; guessing a
  number into a bill of materials is worse than leaving it as a gap. These
  are the phase-2 candidates below, once phase 1's menu-and-applier machinery
  is proven on the lower-risk settings/record shapes.
- **No change to who may configure what.** This is additive to project
  *creation*, gated by the same `PROJECT_PROVISIONING_ENABLED` and sudoers
  grant every other provisioning capability already requires; a deployment
  that never turned on provisioning sees no new behaviour at all.

## Consequences

- One more root-run script (`apply-db-setup.sh`) and one more
  `Cmnd_Alias` entry in `99-linkederp-provisioning`, reviewed the same way as
  the existing nine.
- `CommandRunner.assertProvisioningInvocation` gains an eleventh recognised
  shape (`dbSetupScript`, `<project-name>`-only, mirroring `isModulesList`),
  and `configuration.ts` gains `PROJECT_DB_SETUP_SCRIPT` alongside the other
  provisioning-script env vars — same defaulted/empty-disables posture as
  `PROJECT_RESTART_SCRIPT`.
- The provisioning worker's run time grows by the setup step's duration; still
  one job, still one `dbSetupStatus` surfaced the way `restartStatus` already
  is.
- The recommendation endpoint's prompt and response shape grow (modules +
  configuration + gaps instead of modules alone); `generateStructured`'s
  `maxTokens` likely needs raising past the current 1024 for the Modules-only
  call.
- `ProjectSpecificationRequirement` gains a `kind` field; every reader of a
  stored specification (the agent's context builder, the project page) must
  treat a missing `kind` as `'functional'` for every specification written
  before this ADR.
- A new per-version/edition catalog build (settings toggles enumerated from
  manifests) is a few hundred milliseconds of filesystem reads, the same cost
  `modulesFor` already pays; no new background job.

## Phasing

1. **Phase 1 (this ADR's scope).** Settings toggles, UoM, product
   attributes/variants, warehouse route steps, work centers, company
   name/currency/language. Review tabs on the create form. Gaps become
   `configuration_gap` requirements. `dbSetupStatus`/`dbSetupReport` on the
   project row, with "Run setup again".
2. **Phase 2.** BoM/routing skeletons (structure only, quantities/durations
   left blank and flagged "needs input" rather than guessed), tax and payment
   term records, a retrofit path (`POST /projects/:id/db-setup/recommend`)
   for projects created before this ADR.
3. **Phase 3.** One-click task creation from a `configuration_gap`
   requirement, pre-filled with the requirement text and the applied
   configuration as context, so the agent's generated module is written
   against a database state it can already observe.

## Addendum (phase 1 operational findings + brief upload)

Three bugs found and fixed while verifying phase 1 end-to-end against a real
project (`jokowi`, wood-production brief):

1. **`apply-db-setup.sh` wrote the plan file in the wrong order.** It chowned
   the `mktemp`'d plan file to the `odoo` user, then wrote the plan into it as
   root. With `fs.protected_regular` set (this host's kernel default), root
   cannot open a file in sticky `/tmp` for writing once it is owned by another
   user — `Permission denied`. Fixed by writing first, then chowning.
2. **`mrp.workcenter`'s natural key was too strict.** The driver demanded
   `code`, but `code` is an optional `fields.Char` in Odoo, not required — a
   plan that named a work centre by `name` alone (the common case) was
   refused outright rather than created. Fixed to match on `code` when the
   plan gives one, otherwise on `name`.
3. **The running Odoo server's cache was never invalidated.** The applier
   runs in its own `odoo-bin shell` process, separate from the server a person
   is looking at in the browser. A settings toggle changes `res.groups`
   membership in the database, but the server keeps its own `ormcache` (menus,
   views, group membership) and does not know anything changed until it is
   told. The settings/records were committed correctly the whole time — `Run
   setup again` reporting every item `skipped` on a second run proved that —
   but the UI showed nothing different because the server never got the
   signal. Fixed by calling `registry.clear_all_caches()` and
   `registry.signal_changes()` after commit, the same two calls the server
   makes itself after handling an ordinary request.

Verified on `jokowi` (Odoo 19) after fixes 1 and 2: a plan with 20 entries
applies (17 applied, 3 failed before fix 2; 3 applied after), and a further
run reports all 20 `skipped` (idempotent). Fix 3 is verified only as far as
the driver running cleanly with the signalling calls in place; that the
running instance's UI then shows the changes without a restart still needs
confirming in the browser.

### Brief input: upload + length

Phase 1 shipped with a 4,000-character brief, the limit `RecommendModulesDto`
already used. A brief is routinely longer than that once it comes from a real
requirements document rather than a paragraph typed by hand, so two things
changed together:

- **Length.** The limit is `PROJECT_BRIEF_MAX_CHARS` (12,000), one constant
  shared by `CreateAiProjectDto.description`, `RecommendModulesDto.brief`,
  `RecommendSetupPlanDto.brief` and the portal's textarea
  (`backend/src/modules/projects/project-brief.ts`,
  `frontend/lib/types.ts`). `generateStructured`'s `maxTokens` rose alongside
  it (modules: 1024 → 2048; setup plan: 3072 → 4096) since a longer brief also
  tends to produce a longer configuration/gap list.
- **Upload.** `POST /projects/brief/extract` (multipart, field `file`) reads a
  DOCX, PDF, Markdown or plain-text file and returns its text, cut to the
  12,000-character limit at a paragraph boundary when the source document ran
  longer. Nothing is stored and no project is required — the same
  text-only-in-memory posture as the ADR-030 document upload, whose
  `extractDocumentText` this reuses rather than duplicating the PDF/DOCX
  readers. The portal's create form drops the extracted text into the brief
  textarea, which the person still reviews and edits before Create — an
  uploaded document is a fit-gap *input*, not a bypass of the review screen
  this ADR already requires.

## Verification

- Unit: `keepCataloguedSettings`/`keepCataloguedRecords` drop a field or model
  absent from the live catalog, and independently reject anything failing a
  `^[a-z][a-z0-9_.]*$` floor on model/field names — the same two-layer
  discipline `module-selection-sanitiser.spec.ts` already tests for module
  names.
- Unit: the settings-toggle catalog returns `group_show_uom_price` for 20.0
  Enterprise and omits it for 19.0 Enterprise, built from the real manifests on
  this host (no hand-maintained fixture that could drift).
- Host: `apply-db-setup.sh` run by hand against a scratch project with a
  deliberately malformed entry (unknown field) applies every other entry and
  reports that one `failed`, not the whole plan rolled back.
- End-to-end: creating a project from the wood-production brief produces an
  instance whose `res.config.settings` toggles (the `res.groups` they imply) reflect
  the accepted plan, whose `uom.uom`/`stock.warehouse`/`mrp.workcenter`
  rows match the accepted records exactly, and whose specification carries
  the three `configuration_gap` requirements from §1's worked example.
- End-to-end, idempotency: calling "Run setup again" on an already-applied
  project reports every entry `skipped` (already satisfies its natural key),
  not duplicated records.
