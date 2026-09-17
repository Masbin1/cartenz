# PRD: A Real Odoo Preview Before Approving a Change

| Field | Value |
| --- | --- |
| Document owner | Lead Software Architect |
| Status | Draft — product brief; the technical design is ADR-052 (Proposed) |
| Date | 17 September 2026 |
| Requested by | Operator, item 8 of the request register (`docs/architecture/client-estate-and-server-architecture.md` §6.8) |
| Full technical design | `docs/adr/ADR-052-ephemeral-preview-instances.md` |
| Depends on | ADR-021 (approval gate), ADR-027 (validation runner), ADR-039/049 (root-run scripts), ADR-045/051 (template databases), ADR-050 (repo-backed connected projects) |

This is a short, product-level brief. `ADR-052` already exists with the actual
engineering design and should be read alongside this document — this brief states the
problem and the shape of the solution in plain terms; the ADR states exactly how it is
built, including a constraint this brief only summarises.

## 1. Problem

Today, approving a task means reading a code diff. `DiffViewer` shows the patch,
`ApprovalPanel` names the action and asks for a decision — but nothing shows what the
change actually *does* in Odoo. A reviewer who cannot read the changed XML or Python
confidently is asked to approve blind, and even one who can read code cannot see a
reordered field or a view that raises on open until it runs somewhere.

The operator asked for this directly:

> *"To add the preview that include UI presentation to ensure the user get the complete
> draft before approving and deploying it onto Odoo."*

## 2. Why this is smaller than it looks

Two things the platform already has make this feasible, because they were built for a
different reason (ADR-050's connected-server replica, for a customer whose Odoo lives
on another host):

| What a preview needs | What already exists |
| --- | --- |
| A database with no customer data, full apps installed | A standard template per version, edition and region, cloned in seconds (ADR-045, ADR-051) |
| Real Odoo source for the project's version | The shared, read-only version checkout (ADR-045) |
| A runnable, disposable Odoo | The same generation and teardown pattern `OdooValidationRunner` already uses for a test run |

The one piece that is genuinely new is turning a disposable *test run* into a browsable
*running instance*, reachable by a person for a bounded time, then destroyed.

## 3. The constraint that shapes the design

By the time a person is looking at an approval, **the task's workspace no longer
exists** — it is released the moment the run suspends, whether it settled, paused for
approval, or yielded. There is no clone sitting around to preview from.

ADR-052 solves this by reconstructing the draft rather than assuming a live workspace:
clone the target branch at the task's base commit, then apply the diff the task already
retained (`agent_tasks.diff_patch`). If that patch was truncated or never saved, the
preview says so and refuses rather than showing an incomplete draft. This is the detail
a brief this short cannot substitute for — see ADR-052 §2 for the full mechanism.

## 4. Goals

- A reviewer can request a real, running Odoo showing the branch's changes, before
  deciding to approve.
- No customer data is ever used to build it.
- It costs nothing once the reviewer is done — no instance survives a decision, a
  timeout, or a crashed worker.
- The existing diff view is not replaced; the preview is offered alongside it.

## 5. Non-goals (this phase)

- Previewing against the customer's own data. A preview is always the standard
  baseline database; a client's example database remains a separate, manual restore.
- A permanent staging environment per project. This is ephemeral and one-at-a-time per
  project (ADR-052 §5).
- Previewing an `odoo_online` task — that mode has no filesystem and no draft to clone.
- Deploying to preview it. Deploying is what the approval exists to precede; using
  `pull-project.sh` for preview was considered and rejected (ADR-052, Alternatives).

## 6. What the reviewer sees

- A **Preview** action offered wherever a draft diff exists (before the push approval,
  or the write approval once a chat edit can land) — not started automatically, because
  it costs a database and a process and most tasks will not need it.
- While building: a short wait (dominated by the database clone and module install),
  then a link, clearly labelled as a preview instance running standard data, with the
  remaining time before it is torn down.
- If it cannot be built — no template for that version/edition/region, the patch was
  too large to reconstruct, no capacity — a plain reason, not a missing button.

## 7. Data safety

- The database is always the standard artifact for the project's version, edition and
  region — never the customer's, and never an uploaded example database.
- The code is the task's own retained draft, reconstructed without touching the live
  repository or any customer host.
- The link is authenticated and short-lived, not a public URL, on a domain that cannot
  be mistaken for the customer's own.

## 8. Open questions

Carried from ADR-052, where they are stated as design decisions already made or still
open — restated here at the product level:

1. Which approval gets the Preview action — the plan approval or the pre-push
   approval? ADR-052 assumes the latter, since there is no draft to show before one.
2. How many previews may run at once on one host, and what happens at the ceiling.
3. Whether Odoo can be framed inside the portal or must open in a new tab.
4. The 256 KiB diff-patch cap becomes a real limit: a very large draft may not be
   reconstructable. Raise the cap for review, or say plainly that this draft is too
   large to preview.

## 9. Success criteria

- A reviewer goes from "task waiting for approval" to "looking at the actual Odoo
  screen" in about the time a database clone and module install take — without leaving
  the portal.
- No preview instance ever outlives its TTL, its task's decision, or its owning
  worker.
- No preview has ever run against a client's own database, in any deployment.
- A reviewer who never touches Preview sees no change to the existing diff-and-approve
  flow.

## 10. Status and next step

This is a product brief, not a decision. ADR-052 is **Proposed**, not Accepted — the
open questions above (particularly #1 and #2) should be settled first. Once they are,
ADR-052 moves to Accepted and this brief is the one-page version to hand to whoever
needs the summary rather than the engineering design.
