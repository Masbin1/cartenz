# ADR-084: Odoo Online record reads are capped by page, not by table size

- Status: Accepted
- Date: 27 October 2026
- Milestone: Phase 5 (connected-server estate)
- Amends: ADR-064 (Odoo Online record writes), ADR-028 (execution adapters)

## Context

ADR-064 gave `odoo_search_records` a 100-record cap, the same shape as the
write cap: a bound on what one tool call can do to a live instance. That is
the right posture for a write — "create sample data" never needed more than a
handful of records, and a write is an irreversible effect the moment it lands.

It is the wrong posture for a read. The operator's own use case for this mode
is now "find the wrong or mismatched data" — auditing a live instance for
records that do not match, rows with a stale foreign key, a product whose
price was never updated — and that task is defined by *how much of the table
gets looked at*, not by how many records one call happens to return. A 100-row
cap does not make the read safer: nothing on the instance changes when a
record is read. It only makes the task slower, forcing many small calls where
one capability gap (no paging) is standing in for what should be a policy
decision (how large is one page).

Downloading or exporting the data read this way is explicitly out of scope:
nothing in this mode gains a file, an export format, or any path off the
platform for record data. The record stays inside the task's tool-call
results, read through the same JSON-RPC surface ADR-064 already audits.

## Decision

1. `MAX_RECORDS_PER_READ` rises from 100 to 2000. This is a page size, not a
   ceiling on the investigation — large enough that a single call reads a
   whole small table, small enough that one JSON-RPC response and one model
   turn stay bounded. `MAX_RECORDS_PER_WRITE` is unchanged at 50: writes stay
   at the tight cap ADR-064 set, because the risk a write cap manages (an
   effect on a live instance) did not change.

2. `odoo_search_records` gains `offset`, alongside the existing `limit`. A
   model reading a table larger than one page calls again with `offset`
   advanced by the previous `returned` count. The tool's result adds
   `hasMore` (`offset + returned < total`) so the model does not have to
   re-derive whether another page exists.

3. No new tool, no export, no file and no `unlink`. The only methods the
   client ever sends for a record model remain `search_read`, `search_count`,
   `create`, `write` (ADR-064) — paging is a parameter on a method already
   permitted, not a new capability. The protected-model list
   (`odoo-record-surface.ts`) and the write approval path are untouched.

## Consequences

- A chat or task that asks Cartenz to find mismatched records on an Odoo
  Online instance can now walk an entire model by paging, within the existing
  `database_record_read` permission (still off by default, still no approval
  required for a read — reading was never the boundary chapter 12 gates).
- A table with millions of rows is still walked one page at a time rather
  than in one unbounded call; "no limit on the investigation" means no limit
  on the total records examined across calls, not that any single call can
  return an arbitrary amount in one shot.
- Nothing about writes changed: `odoo_create_records` and
  `odoo_update_records` keep their 50-record cap and their approval gate
  exactly as ADR-064 left them.

## Retirement condition

Revisit if a request needs the read data to leave the platform (a file export,
a download link) — that is a different capability with a different risk
(data exfiltration from a live customer instance) and needs its own decision,
not a larger page size.
