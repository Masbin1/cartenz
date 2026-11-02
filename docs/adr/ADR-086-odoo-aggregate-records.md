# ADR-086: Native aggregation (read_group) for Odoo Online and on-premise

- Status: Accepted
- Date: 27 October 2026
- Milestone: Phase 5 (connected-server estate)
- Amends: ADR-064 (Odoo Online record writes), ADR-075 (on-premise record access)

## Context

`odoo_search_records` (ADR-064, paged by ADR-084) answers "show me the rows".
It cannot efficiently answer "what is the total" — a question like "total
sales by month" or "count of leads by stage" would otherwise require reading
every matching row across as many paged calls as the table needs, then
summing in the model's own reasoning. That is slow, token-expensive, and
exactly the kind of query Odoo already has a dedicated, server-side primitive
for: `read_group`, the same RPC call the pivot view and every dashboard widget
in Odoo itself uses.

## Decision

A new tool, `odoo_aggregate_records`, available on both `odoo_online` and
`on_premise` (ADR-075's two executors), behind `database_record_read` like
`odoo_search_records` - reading an aggregate is no more a mutation than
reading a row.

- **Request shape**: `model`, `domain`, `fields` (each optionally suffixed
  `:function` - `amount_total:sum`, `id:count`, `margin:avg`, `date_order:max`
  - functions: sum, avg, count, count_distinct, min, max), `groupBy` (each
  optionally suffixed `:granularity` for a date/datetime field -
  `date_order:month`), `limit` (groups, not rows).
- **Caps**: 20 aggregated fields, 5 groupBy fields, 1000 groups per call
  (`MAX_GROUPS_PER_AGGREGATE`) - generous because a group is a summary row,
  not a record; 1000 distinct groups is already an unusually fine-grained
  breakdown.
- **Both executors validate identically**: `validateAggregateRecords` in
  `odoo-record-surface.ts` for the shape and field-pattern checks the tool
  layer makes before anything leaves the platform; `op_aggregate` in
  `project-records-driver.py` re-checks the same shape and additionally
  verifies every named field exists on the live model via `_fields`, exactly
  as the write operations already do.
- **No new RPC surface beyond `read_group` itself**: Odoo Online's client adds
  `read_group` to `RECORD_METHODS` (joining `search_read`, `search_count`,
  `create`, `write`); the on-premise driver's `HANDLERS` map adds `'aggregate'`
  beside `search`, `count`, `create`, `write`. No `unlink`, no `execute`, no
  dynamic method name - the same floor ADR-064 set.
- **Protected models are still protected**: `recordModelRefusal` /
  `protected_model_reason` run before `read_group` reaches either executor,
  identically to every other record operation.

## Consequences

- A chat or task asking "total sales by month" or "count of leads by stage"
  computes the answer on the instance in one call, instead of reading
  potentially thousands of rows across paged `odoo_search_records` calls and
  summing them in the model's own context.
- No write capability changed: aggregation is read-only by construction
  (`read_group` never creates, updates or deletes anything), so it needed no
  new approval action.
- The on-premise driver's `op_aggregate` is the only new operation added to
  `project-records-driver.py` beyond ADR-075's original four.

## Retirement condition

Revisit if a request needs an aggregation Odoo's own `read_group` cannot
express (e.g. a window function or a cross-model join) - that is a different,
larger capability and needs its own decision, not an extension of this one.
