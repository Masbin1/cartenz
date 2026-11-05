# ADR-093: A browser write counts as a change to the instance

- Status: Accepted
- Date: 4 November 2026
- Milestone: Phase 5 (connected-server estate)

## Context

task_551621 asked for sample data to test three fields created in an
earlier task. The model drove the signed-in browser through creating two
products and a Sales Order - `browser_type` into the product name, cost
and sales price fields, `browser_click` on "Save manually" (confirmed by
the page's own aria snapshot: `button "Save manually" [ref=e61]`) - twice
for the two products, then started on the Sales Order before the step
budget ran out. The task failed with "Nothing was changed on the instance:
the step budget of 30 was exhausted" - which is misleading at best: real
writes almost certainly landed (two `browser_click` calls on the Save
button, at URLs that are the product-creation screen), and the task still
reported zero changes.

Root cause: `implementOdooOnline`'s `applied` array - the evidence a
summary is checked against, the same role `git diff` plays for the
repository-based modes - is only appended to when the tool that just
succeeded is in `CHANGING_ODOO_TOOLS`. That list held the five RPC write
tools (`odoo_create_field`, `odoo_create_model`, `odoo_add_field_to_view`,
`odoo_create_records`, `odoo_update_records`) and had never been updated
to include a browser tool at all, from ADR-087 through ADR-090. A write
made by clicking "Save" in the signed-in browser is exactly as real as one
made by calling `odoo_create_records` - the tool used to make it is an
implementation detail, not a reason to disbelieve it happened.

This is a correctness bug independent of ADR-090/091/092: even a task that
successfully writes real data through the browser, with no approval or
target-model or resumption problem anywhere in it, was reported as having
changed nothing, purely because of what tool happened to make the write.

## Decision

Added `browser_click` and `browser_type` to `CHANGING_ODOO_TOOLS`.
`browser_navigate` and `browser_snapshot` are deliberately excluded - they
read a screen (open a URL, take an accessibility snapshot), they do not
change one.

`describeOdooChange` gained a case for the two browser tools. Unlike the
RPC tools, a browser action's result is a screen (url, title, aria
snapshot), not an id Odoo assigned to a created or updated record - there
is nothing resembling "Created field x on y (id z)" to report honestly.
The browser case names only what is known for certain: `Acted in the
browser on <title or url>.` It does not claim to know whether the action
was a save, a line added, or a field filled - the model's own summary,
narrated alongside this line, says that; this line exists solely so the
task is not reported as having changed nothing when a write tool did run
and succeed.

Both are exported (`CHANGING_ODOO_TOOLS`, `describeOdooChange`) so this
behaviour is covered by its own test file rather than only exercised
indirectly through a task-level integration test.

## Consequences

- A task that writes through the browser and then runs out of budget,
  crashes, or is cancelled before finishing is now reported with whatever
  it did manage before that happened, instead of "nothing", which is the
  same honesty standard the five RPC tools already had.
- `browser_click`/`browser_type` being counted here says nothing about
  whether the click or type the model made was the *right* one - a wrong
  click still counts as "something changed", for better or worse, exactly
  as a wrong `odoo_update_records` call already did. The model's summary
  and the person reviewing the task remain the only check on whether the
  right thing was clicked.
- Does not, by itself, change whether a browser-driven task finishes
  within its step budget - that is a separate problem (see the open
  question in `docs/adr/README.md`'s Odoo Online section about
  browser-driven writes needing many more round-trips than the equivalent
  RPC call).
- Tests: `agent-workflow-odoo-change-detection.spec.ts` (new, 7 cases)
  covering both lists' new and existing entries and `describeOdooChange`'s
  new browser case, including the url-only fallback when a screen has no
  title.
