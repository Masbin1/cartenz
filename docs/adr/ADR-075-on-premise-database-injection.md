# ADR-075: An on-premise project's database is reachable — from the brief and from a prompt

- Status: Proposed
- Date: 19 October 2026
- Milestone: Phase 5 (connected-server estate)

Builds on ADR-026 (on-premise deployment), ADR-028 (execution modes),
ADR-039 (a created project is a running instance), ADR-045/051 (template
databases and the standard-database catalog), ADR-064 (record writes are gated
by permission and approval) and ADR-073 (fit-gap database setup at project
creation).

## Context

ADR-064 gave `odoo_online` three record tools and the policy around them: a
project-level permission, a per-write approval, a fixed set of models that is
never a record target, four client methods and no others, and a cap on how many
records one call may touch. That is the shape the operator wants everywhere.

`on_premise` has none of it. Its entire tool surface is `detect_odoo_version`
and `list_modules` (`backend/src/agent/tools/real/odoo.tools.ts`), both of which
read module manifests and neither of which touches a database. The record tools
declare `modes: ['odoo_online']`, so `permission-validator.ts` refuses them on
an on-premise task no matter what the project's permissions say. A project can
have `database_record_read` and `database_record_write` turned on and still
answer, correctly, that it has no tool to write a record — which is what
`task_413469` and `task_783226` did.

ADR-073 opened a second, narrower door: at project creation, a plan derived from
the brief is applied by a root-run script. That script works, but its record
vocabulary is a hand-written list of four models
(`RECORD_MODELS` in `infrastructure/provisioning/apply-db-setup-driver.py`:
`product.attribute`, `uom.uom`, `mrp.workcenter`, `stock.warehouse`), it refuses
every relation with no hand-written resolver, and it runs **only** at creation
or from "Run setup again" with the same stored plan. It cannot answer "buatkan
50 produk sparepart" a week later, and it cannot answer it in a chat.

The operator's requirement is one sentence: an on-premise project's database
must be fully reachable — every business model, not a fixed list — with a person
approving the write, and the *same* capability must serve both doors:

- **the brief**, where Cartenz reads the description, composes the data,
  presents it for review before Create, and injects it after provisioning;
- **the prompt**, where a person asks in chat or in a change task, Cartenz
  composes the data, the person approves, and it is injected immediately.

Two facts make this cheaper than it looks. First, Cartenz runs on the same host
as the instance it provisioned (ADR-026, ADR-039), and already holds a
root-gated script grant for exactly this kind of work — `apply-db-setup.sh` is
in the `LINKEDERP_PROVISION` sudoers alias today
(`infrastructure/provisioning/99-linkederp-provisioning:115`). Second, the
policy that keeps a record write safe already exists and is already tested for
Odoo Online; what is missing is a second executor for it, not a second policy.

## Decision

### 1. One engine, two doors

A single applier answers both doors. The difference between them is *who
composed the plan and when a person saw it*, never what the engine is allowed to
do:

| | Brief | Prompt |
| --- | --- | --- |
| Composed by | recommendation endpoint + review screen | the agent, mid-conversation |
| Approved by | ticking items on the Create form (ADR-073 §4) | `odoo_record_write`, the same gate as a chat file write |
| Executed by | `apply-db-setup.sh` inside the provisioning job | `project-records.sh`, called as a tool |
| Timing | after modules install, before the service starts | immediately, against a running instance |

Two scripts, one shared policy module. `apply-db-setup.sh` keeps its
`<project-name>`-only shape and its stdin plan; the new
`project-records.sh` takes `<project-name>` and a request on stdin. Both resolve
the project the same way `apply-db-setup.sh` already does — the directory under
`/opt/odoo` or `/opt/odoo20`, `db_name` from that project's own `odoo.conf`,
never a database name from an argument — and both feed a **fixed, human-written**
Python driver to `odoo-bin shell`. No part of either path executes model-authored
source (ADR-073 §3, ADR-020).

`infrastructure/provisioning/odoo-record-policy.py` holds what must not drift
apart: the protected-model prefixes, the model/field name pattern, and the two
caps. Each driver imports it from the script's own directory (passed in the
environment, since a driver read from stdin has no `__file__`).

### 2. The model surface is a deny-list, not an allow-list

ADR-073's four-model whitelist is replaced for on-premise by the rule ADR-064
already applies to Odoo Online: **any model whose name passes the pattern is
reachable, except the instance's own machinery.** The protected prefixes are the
same list, kept in one place on each side:

```
ir.*        base.*      base_import.*   bus.*        auth_*     auth.*
iap.*       res.users   res.groups      res.config   res.device
fetchmail.* mail.alias  payment.provider             account.online
```

`res.users`, `res.groups` and `res.config.*` are authentication and
configuration, not sample data; `ir.*` is the instance's code, views, actions,
rules and crons. A record write there is a change to who can log in or what code
runs, which is out of scope for a data-injection feature whatever a project's
permissions say.

Two independent copies of that list exist on purpose — the TypeScript one in
`backend/src/agent/odoo-online/odoo-record-surface.ts` (the tool layer's
refusal) and the Python one in `odoo-record-policy.py` (the executor's). A unit
test parses the Python constant and asserts it equals the TypeScript array, so
the two cannot drift silently, the same defence-in-depth posture ADR-064 §1
describes for `recordCall`.

The driver additionally re-checks every model and field against the live
registry's `_fields` before use, so even a bypass above cannot produce an
`AttributeError` mid-run: an unknown field is a refused entry, not a partial
write.

### 3. What a plan may contain

The brief's plan keeps ADR-073's shape and gains one entry kind and one
mechanism:

```
{ configuration: [ {kind: 'setting'|'record'|'company'|'language', ...} ],
  refs:          [ {ref: 'unit_pcs', model: 'uom.uom', values: {...}} ] }
```

- **`setting`**, **`company`**, **`language`** are unchanged from ADR-073 §2–3.
- **`record`** loses its four-model whitelist. It carries `model` and `values`,
  validated against the deny-list and the live registry, applied in one
  savepoint per entry exactly as `apply_record` does today.
- **`refs`** are the answer to relations. ADR-073 refused every `many2one` with
  no hand-written resolver, which made a product (needing `uom_id`,
  `categ_id`) impossible to create. A ref is a labelled record resolved in plan
  order: created if its natural key is absent, found if present, and referenced
  by later entries as `{"$ref": "unit_pcs"}` in any `many2one` field (`values`
  or a `record` entry). Forward references are refused; a duplicate label is
  refused; a ref to a protected model is refused like any other. Resolution
  never invents: a ref that matches nothing creates exactly the record the plan
  described, and nothing else.

A `record` entry may also carry `attributeValues` as today (product attributes),
and an optional `naturalKey` naming the field(s) that make it idempotent —
defaulting to `name` when the model has one. An entry whose natural key already
matches is reported `skipped`, which is what makes "Run setup again" safe
(ADR-073 §5).

Caps, matching the Odoo Online surface: **50 records per entry, 200 entries per
plan, 200 refs**. A plan larger than that is refused whole rather than applied
in part.

### 4. The chat path is a tool, not a shell

Three tools become available in `on_premise` as well as `odoo_online`:

- `odoo_search_records` — `search_read` + `count`, `database_record_read`,
  `leavesPlatform: false`;
- `odoo_create_records` — batched create, `database_record_write`,
  `leavesPlatform: true`;
- `odoo_update_records` — batched write by id, `database_record_write`,
  `leavesPlatform: true`.

Their `modes` arrays become `['odoo_online', 'on_premise']`. Their schemas,
validators and caps are shared unchanged — `validateCreateRecords`,
`validateUpdateRecords`, `effectiveReadLimit`, `MAX_RECORDS_PER_WRITE` and
`MAX_RECORDS_PER_READ` are already mode-agnostic. What changes is the executor:
for `on_premise`, the tools call a new `ProjectRecordsClient` that renders the
same validated call as a JSON request and runs
`sudo -n project-records.sh <project-name>` through `CommandRunner`, instead of
driving JSON-RPC.

The request has four operations and no others — `search`, `count`, `create`,
`write`. No `unlink`: deleting a customer's records is not data injection, and
ADR-064 §2 already excluded it for Odoo Online. No dynamic method name, no
`execute`, no `fields_get`-shaped escape hatch.

`project-records.sh` derives `<project-name>` from the project row (the
technical name the provisioning scripts already use), never from the prompt, and
the tool passes that single argument. Reads from a chat return at most 100
records; a write at most 50, which is the same ceiling a chat write has on Odoo
Online.

### 5. A write always has a person in the loop

No new approval machinery. The policy is ADR-064's, applied unchanged:

- `database_record_read` and `database_record_write` already exist, already
  default to `false`, and the object-write one is already in
  `APPROVAL_BEARING_PERMISSIONS`.
- In a **chat** task, `odoo_create_records`/`odoo_update_records` declare
  `leavesPlatform: true` and map to `odoo_record_write`; the run suspends into
  `waiting_approval` before anything reaches the database, exactly as a file
  write suspends under `chat_edit`. This is the same gate as an add-code or
  create-module action.
- In a **change** task, the approved implementation plan is the approval, as
  ADR-064 §4 already established: re-asking mid-implementation would suspend a
  live run for a decision a person already made.
- In the **brief**, the review screen is the approval — ticking an item is what
  puts it in the plan (ADR-073 §4). Nothing is applied that was not on the
  reviewed list.

The "changed nothing = failed" rule extends to the new executor unchanged: a
create returns the ids Odoo assigned, or the tool call did not happen.

### 6. A failed injection is a warning, not a failed project

The instance is real and running; the data is a bonus on top of it. A failing
entry rolls back its own savepoint and reports `failed`; the remaining entries
still apply. The script prints `WARN: settings <message>` (brief) or
`WARN: records <message>` (prompt) for anything that prevented the step from
running at all, and still exits 0, so the provisioning job continues and the
project stays `provisioned`.

`ProjectDbSetupService` already catches a non-zero exit and records
`partial`/`failed` on the project row without failing provisioning
(`project-db-setup.service.ts:98-124`); it gains one thing: retaining the
`WARN:` lines it finds on stdout alongside the per-entry report, so the project
page can show *why* a plan applied nothing instead of an empty report. For the
chat path the tool call itself returns the failure as a normal tool error — the
agent sees it, retries or reports it, and the conversation continues.

### 7. Privilege is unchanged

`project-records.sh` joins the same `Cmnd_Alias LINKEDERP_PROVISION` as the
existing eleven scripts, takes `<project-name>` only, and is recognised by
`CommandRunner.assertProvisioningInvocation` as a new disjoint shape next to
`isDbSetup`. It runs `odoo-bin shell` as the `odoo` user against the database
named by that project's own `odoo.conf` — the same two facts a backup, a module
list and ADR-073's applier already rely on. No database role for `cartenz`, no
API key, no new port, no direct SQL.

Because it runs as root, every value it acts on is validated by shape before
use: the project name against the existing pattern, model and field names
against `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)?$`, plan keys against the catalog,
selection values against the live field's own legal values, and relations only
through an in-plan ref or a raw id that is confirmed to exist. Nothing from a
prompt is ever interpolated into a shell command or into Python source.

## Out of scope

- **No `unlink`, no `ir.*`, no users/groups/config.** Same boundary as
  ADR-064 §1–2, applied to the second executor.
- **No direct SQL and no arbitrary ORM call.** The driver knows a fixed set of
  operations; extending it is a reviewed change, not a runtime decision.
- **No attachment/binary writes, no mail sending, no cron invocation.**
  Binary fields are the one field type the driver refuses rather than coerces.
- **Odoo Online and Odoo.sh are unchanged.** No tool gains `odoo_sh`; the
  assisted-creation flows (ADR-070, ADR-071) are untouched.
- **No settings-catalog change.** ADR-073's toggle/company/language vocabulary
  stays exactly as it is; this ADR widens *records*, not settings.

## Consequences

- One more root-run script (`project-records.sh`), one more entry in
  `99-linkederp-provisioning`, one more `Cmnd_Alias` shape in
  `assertProvisioningInvocation` and one more configuration key
  (`PROJECT_RECORDS_SCRIPT`, empty disables the tools exactly as an empty
  `PROJECT_DB_SETUP_SCRIPT` disables setup).
- `odoo-record-surface.ts`'s policy becomes shared by two modes; the Python copy
  is added and pinned to it by a test.
- ADR-073's `RECORD_MODELS` list in `apply-db-setup-driver.py` shrinks to the
  deny-list rule plus refs; `apply-record`'s four hand-written shapes become
  one validated shape. Plans already stored keep working: their entries name
  `product.attribute`, `uom.uom`, `mrp.workcenter` and `stock.warehouse`, all of
  which are ordinary record entries under the new rule.
- The brief's recommendation prompt grows: it may now name any model on the
  instance, so `maxTokens` rises and the response is filtered against the live
  registry rather than a four-model list.
- A chat on an on-premise project with both record permissions granted can
  finally answer "buatkan sample data" with records, pausing once for approval —
  the gap ADR-064 closed for Odoo Online, closed for the other mode that owns
  its own database.

## Phasing

1. **Phase 1 (this ADR).** `project-records.sh` + driver + shared policy;
   `on_premise` added to the three record tools; refs and the dynamic record
   rule in ADR-073's applier; `WARN:` retention. Chat and change get writes;
   brief gets arbitrary business records.
2. **Phase 2.** Delete (`unlink`) behind its own approval action, and
   attachment upload — both deliberately refused here.
3. **Phase 3.** Sample-data recipes (a named bundle such as "sparepart shop
   starter set") so the brief path is not inventing every record from prose.

## Verification

- Unit: `odoo-record-surface.spec.ts` asserts `recordModelRefusal` refuses
  `res.users`, `ir.model`, `res.config.settings` and accepts
  `product.template`, and a new spec parses `odoo-record-policy.py`'s prefix
  tuple and asserts it equals the TypeScript one.
- Unit: `validateCreateRecords`/`validateUpdateRecords` are unchanged and still
  refuse more than 50 records, an unknown operation, and a protected model.
- Unit: the tool registry exposes `odoo_create_records` with
  `modes: ['odoo_online', 'on_premise']` and `leavesPlatform: true`.
- Unit: a `many2one` value given as `{"$ref": ...}` resolves in plan order and
  a forward reference is refused; a plan with 201 entries is refused whole.
- Host: on a scratch project, `project-records.sh` creates 5 products in one
  call and reports their ids; a second identical `create` with the same natural
  key is `skipped`; a request naming `res.users` is refused before the ORM is
  touched.
- Host: a brief plan containing a product, its UoM ref and its category applies
  end-to-end on 19.0 and 20.0.
- End-to-end: a chat on an on-premise project with `database_record_write` on
  pauses for approval, and after approval the records exist in the instance.
- Regression: an on-premise project with no record permissions behaves exactly
  as today; an Odoo.sh project's tool list is unchanged.
