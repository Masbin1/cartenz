# ADR-068: Odoo Online can create a model, as one Studio-shaped sequence

- Status: Accepted
- Date: 28 September 2026
- Milestone: Phase 5 (connected-server estate)
- Amends: ADR-028 (execution adapters), ADR-064 (record writes)

## Context

ADR-028 gave `odoo_online` a customization surface of four tools:
`odoo_list_models`, `odoo_list_fields`, `odoo_create_field`,
`odoo_add_field_to_view`. ADR-064 added three record tools. Every one of them
works on something that already exists: a field is added to a model, a field is
placed on a form, records are written into a model. The surface can extend a
schema, never introduce one.

That is a gap between what the mode is for and what it can do. ADR-028 describes
`odoo_online` as "customization through Studio, driven with the project's
credentials", and creating a model is the first thing Studio is used for. The
operator asked for it directly: "bisa create model juga dong harusnya". A person
who can ask for a custom field on `sale.order` and get one reasonably expects
"buatkan model baru untuk data servis" to work the same way.

The mechanism was verified against the Odoo 19 source on this host rather than
assumed, the way ADR-028's original surface was verified against a live instance:

- `ir.model.create` is the supported path for a manual model. The base module
  accepts it and rebuilds the registry and the database table
  (`odoo/addons/base/models/ir_model.py`, `create`): `manual` models are
  detected by `state`, `pool._setup_models__` reloads them, and
  `pool.init_models(..., update_custom_fields=True)` creates the table.
- A manual model must be named `x_…`. Two constraints enforce it
  (`_check_model_name` → `_check_manual_name`) and the object-name regex allows
  only lowercase letters, digits, underscores and dots.
- Creating a model is not one call. Studio's `studio_model_create`
  (`enterprise/web_studio/models/ir_model.py`) creates the `ir.model` row with
  `x_name` nested in `field_id`, then calls `_setup_access_rights()` for *two*
  `ir.model.access` rows (`base.group_system` with full rights, `base.group_user`
  with read, write and create but no unlink), then materialises views through
  `create_automatic_views()`. A model created without those is a row nobody can
  open, no group can write to, and no field can be added to a form of.
- `create_automatic_views()` is a `web_studio` method
  (`enterprise/web_studio/models/ir_ui_view.py`), so it exists only where Studio
  is installed. The equivalent views are therefore created directly here rather
  than by calling it, so the sequence does not depend on a Studio subscription on
  the customer's instance.

The client's allow-list (`CUSTOMIZATION_MODELS`) holds `ir.model`,
`ir.model.fields` and `ir.ui.view`. Two of the artefacts a usable model needs —
`ir.model.access` and the views — sit outside it, so the whitelist has to grow
for this to be anything but a half-made model.

## Decision

`odoo_online` gains one tool, mode-gated to it exactly as the existing seven are:

- `odoo_create_model` — `label` (the human label) and `model` (the technical
  `x_…` name), behind `odoo_customize`, the permission that already governs
  schema changes. No new permission is introduced: creating a model *is*
  customization, and inventing a permission for it would put two switches on
  one decision.

It performs Studio's sequence as one unit, in this order, and the order is the
decision:

1. `ir.model` create (`model`, `name`, `state: manual`) with `x_name` nested in
   `field_id`, exactly as Studio does it, returning the model id. Nesting is not
   cosmetic: it is what makes the field's `model_id` resolve against the row being
   created in the same call.
2. `ir.model.access` create, twice, for `base.group_system` (full) and
   `base.group_user` (read/write/create, no unlink), matching
   `_setup_access_rights()` exactly. The group ids are resolved from
   `ir.model.data` before the model row is written, so a missing group is a clean
   refusal rather than a model created with no access rules.
3. Materialise a default form view and a default list view for the new model as
   `ir.ui.view` records. The form view is what `odoo_add_field_to_view` inherits
   from, so without it the model exists but cannot be customized any further —
   which would make the tool half-useful. A search view is not created:
   `odoo_add_field_to_view` only ever touches the form.

Five things hold, in the shape ADR-064 established:

1. **Only manual models, only `x_` names.** The model name is validated against
   Odoo's own rule before the call leaves the platform:
   `^x_[a-z0-9_]+(\.[a-z0-9_]+)*$`. A name that does not match is refused, not
   sent and rejected. This is also what makes the tool incapable of colliding
   with a module's model. The rule is Odoo's, not a stricter one: dotted names
   after the prefix (`x_servis.line`) are accepted, because the instance accepts
   them.
2. **The client's write allow-list grows by exactly one model.**
   `ir.model.access` joins `CUSTOMIZATION_MODELS`. Separately, `ir.model.data`
   becomes readable, and only readable: a `READ_ONLY_MODELS` set in the client
   admits `search_read` and `search_count` against it and nothing else. The
   sequence needs it to resolve `base.group_system` and `base.group_user` to
   ids without reading `res.groups`, which the record surface protects.
   `ir.actions.act_window` and `ir.ui.menu` are in neither set: putting a model
   in the menus is a separate decision about where it belongs in a customer's
   application, and a model that exists, is accessible and has form and list
   views is already usable from a direct URL and from Studio.
3. **One model per call, and no delete.** The tool creates; `ir.model` `unlink`
   stays absent from the client, as `unlink` is absent from the record surface.
   Deleting a model drops its table, which is not a customization an agent should
   reach in one call — and the Odoo path that does it is the same path that can
   drop a module's table, so the refusal is structural rather than a parameter.
4. **A model creation always has a person in the loop, in the shape ADR-064
   already uses.** `odoo_create_model` declares `leavesPlatform: true` and maps
   to a new approval action, `odoo_model_create` (`APPROVAL_ACTIONS` in
   `core/enums.ts`), with a label in `approval-panel.tsx`. It is a **separate
   action from `odoo_record_write`**: a plan that says "create sample data" is
   not consent to change the shape of the database, so the two are not the same
   grant. The mechanism is ADR-064's: in a chat task the call pauses into
   `waiting_approval` exactly as a record write does; in a change task, a plan
   step that named the model is what a person already approved, so
   `implementation_plan` stands in for `odoo_model_create` there, the same
   relationship it already has with `odoo_record_write`. There is no blanket
   "approve for this session" grant: each model is its own plan step or its own
   chat pause.

   The operator asked for the capability ("bisa create model juga dong
   harusnya"); the approval shape was not put to them as a separate question
   that got an answer, and was chosen here as the existing, reviewed pattern for
   a write to a live instance. Revisit it if the operator wants it tighter.

5. **The existing surface is unchanged.** `odoo_create_field` still adds fields
   to shipped models (`sale.order` and the rest); nothing here narrows it. That
   was chosen as the default when the question went unanswered, not confirmed by
   the operator. The two tools answer different questions — "extend this thing"
   versus "make a new thing" — and the second being gated more tightly is not a
   claim about the first.

The implementation step's changed-nothing rule extends by one entry:
`odoo_create_model` joins `CHANGING_ODOO_TOOLS` in `agent-workflow.ts`, so a run
that claims to have created a model without a tool result carrying the model id
fails the same way a claimed-but-absent field already does.

The chat, planner and implementation prompts each gain one line for the tool and
state the `x_` requirement. A name collision is not left to the prompt: the
client searches `ir.model` for the name first and refuses before writing
anything if it exists.

## Consequences

- "Buatkan model baru untuk data X" on an `odoo_online` project now creates a
  usable model — row with its display-name field nested in, access rules and a
  form and list view — pausing once for approval, instead of answering that no
  such tool exists.
- `ir.model.access` is newly reachable through this client, but only as a
  consequence of this tool's own sequence: it is in the customization allow-list,
  so a caller reaching it through `call()` is a deliberate change to this file,
  not something a tool argument can select. The record surface's protected-model
  refusal (`odoo-record-surface.ts`) still refuses `ir.model.access` as a *record*
  target, so the two paths do not overlap. `ir.model.data` is reachable too, but
  read-only (`search_read` only): it exists solely to resolve the two group ids,
  never to write.
- The blast radius of one call is one model plus its two supporting layers
  (access rights, views). A second model is a second approval.
- A model created this way is not in any menu. That is the deliberate boundary of
  this ADR, and the reason `ir.actions.act_window` is not in the allow-list: a
  follow-up request to publish the model needs its own decision about placement,
  and the model is already usable before it is made.
- Odoo.sh and on-premise are unaffected: the tool declares
  `modes: ['odoo_online']`, and the mode gate in `permission-validator.ts`
  refuses it elsewhere, as every mode-gated tool already is.

## Retirement condition

The three-layer shape (model, access, view) is retired only if Odoo itself makes
a manual model usable from the `ir.model` row alone. Until then, a tool that
creates the row without the other two produces a model the user cannot use, which
is worse than refusing.
