# ADR-064: Odoo Online records are reachable, gated by permission and approval

- Status: Accepted
- Date: 25 September 2026
- Milestone: Phase 5 (connected-server estate)
- Amends: ADR-028 (execution adapters)

## Context

ADR-028 gave `odoo_online` a narrow tool surface on purpose: `odoo_list_models`,
`odoo_list_fields`, `odoo_create_field`, `odoo_add_field_to_view`. All four touch
`ir.model`, `ir.model.fields` or `ir.ui.view` - schema and views, never a business
record - and the client (`odoo-online-client.ts`) enforced that with a model
allow-list, so the refusal held even if a tool were added carelessly later.

That was the right posture for what the mode did at the time: customization,
Studio-style. It is the wrong posture for what people actually ask it for. The
project's own task history shows the mismatch directly - `task_397329`, a chat
asking "kamu bisa buatin sample data gak disini?", answered:

> Tool saya cuma bisa: lihat model/field, buat custom field, tambah field ke
> view. Gak ada tool buat insert/isi record data (sample/demo data).

The operator's request (task compacted from this conversation) is exactly the
case ADR-028 didn't cover: "kalau saya minta buatkan sample data product untuk
saya, ya Cartenz harus buatkan sample product di project Odoo Online-nya" - a
project already connected, with its URL, database and API key on file, where the
whole reason to ask the agent anything is often "put some data in this". A mode
that can never write a record cannot do that, no matter how good its prompt is.

## Decision

Odoo Online's tool surface gains three tools, all mode-gated to `odoo_online`
exactly as the existing four are:

- `odoo_search_records` - `search_read` + `search_count`, behind
  `database_record_read`.
- `odoo_create_records` - batched `create`, behind `database_record_write`.
- `odoo_update_records` - batched `write` by id, behind `database_record_write`.

Both permissions already existed (`agent-permissions.ts`), already default to
`false`, and `database_record_write` was already in
`APPROVAL_BEARING_PERMISSIONS` - chapter 12's data-blind posture was written to
be lifted per project, not to be permanent. Lifting it for Odoo Online record
tools is turning on machinery that was already there for this, not inventing a
bypass.

Four things hold even when both permissions are on, because the permission
answers "may this project's agent ever write a record", not "which models" or
"how much":

1. **A fixed set of protected models never becomes a record target.**
   `odoo-record-surface.ts` refuses every model under `ir.*`, plus users, groups,
   config, and outbound infrastructure (`res.users`, `res.groups`,
   `res.config.*`, `fetchmail.*`, `payment.provider`, ...), regardless of
   permission or approval. `res.users` is authentication, not sample data; the
   surface distinguishes "customer records" from "who can log in and what code
   runs" and only the former is reachable. The client checks this again
   (`recordCall`) independently of the tool layer, the same fail-closed pattern
   ADR-028's `CUSTOMIZATION_MODELS` set already used.

2. **The client's record path has four methods and no others.**
   `search_read`, `search_count`, `create`, `write`. Not `unlink` - deleting
   customer records is not what "sample data" asked for, and nothing in this
   mode needs it. Not `execute` or any dynamic method name - a client that can
   run an arbitrary method on an arbitrary model is the allow-list defeated in
   one call. A future capability that needs a fifth method is a deliberate,
   reviewed addition to this set, not a parameter the caller controls.

3. **A call is capped.** 50 records per create/update call, 100 per search
   (`MAX_RECORDS_PER_WRITE`, `MAX_RECORDS_PER_READ`). "Buatkan sample data" is a
   handful of records, not a script that fills a customer's database; a cap that
   low is not a real constraint on the request this exists for; it is a limit on
   what one ill-considered tool call can do to a live instance.

4. **A write always has a person in the loop**, through the existing approval
   machinery rather than a new one: `odoo_create_records` and
   `odoo_update_records` declare `leavesPlatform: true` and map to a new
   approval action, `odoo_record_write` (`APPROVAL_ACTIONS` in `core/enums.ts`).
   In a chat task this pauses into `waiting_approval` exactly as a file write
   does under `chat_edit` (ADR-029) - the model calls the tool, the platform
   suspends before anything is sent to Odoo, and the run resumes once a person
   decides. In a change task the plan is the approval: a person already approved
   "create N sample products" as a plan step, so re-asking mid-implementation
   would suspend a live run a second time for a decision already made: the
   `implementation_plan` grant stands in for `odoo_record_write` there, the same
   relationship `git_push` under an auto-approved deployment already has.
   Record reads need no approval, matching every other read tool on the
   platform: reading is not the boundary chapter 12 was written to gate.

The implementation step's "changed nothing = failed" rule (added for
`odoo_create_field`) extends to the record tools unchanged: a create or update
either returns the ids Odoo assigned or it does not run at all, so a chat or
plan step that claims to have made sample data without a tool result saying so
still fails the same way a claimed-but-absent field creation already did.

Both mode-specific prompts - the chat instruction and the Odoo Online planning
and implementation instructions - are extended to describe the record tools and
tell the model to use `odoo_list_fields` before creating, so a required field is
not left empty and a "sample data" request produces something Odoo actually
accepts.

## Consequences

- A chat prompt like "buatkan sample data product" on a project with both
  permissions granted now creates the products, pausing once for approval,
  rather than answering that no such tool exists.
- A project's agent permissions govern this exactly as they govern every other
  capability: `database_record_write` stays off by default, so nothing changes
  for an existing project until an admin turns it on in project settings
  (`PERMISSION_NOTES` in `frontend/app/projects/[projectId]/settings/page.tsx`
  already describes both permissions; no frontend change was needed for the
  toggle itself).
- `res.users`, `res.groups` and the `ir.*` estate remain unreachable as record
  data no matter what a project grants - the data-blind posture chapter 12
  describes for configuration and access continues to hold; ADR-028's
  data-blind description of *business* records is what this ADR narrows, for
  Odoo Online specifically, under permission and approval.
- Odoo.sh and on-premise are unaffected: the new tools declare
  `modes: ['odoo_online']`, so the mode gate in `permission-validator.ts`
  refuses them anywhere else, the same enforcement ADR-028 already relies on for
  every mode-gated tool.
