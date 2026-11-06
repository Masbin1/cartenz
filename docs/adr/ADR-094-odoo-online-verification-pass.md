# ADR-094: Odoo Online tasks verify what they built, not just that Odoo accepted it

- Status: Accepted
- Date: 5 November 2026
- Milestone: Phase 5 (connected-server estate)

## Context

task_837942 created three Monetary fields on `sale.order` through
`odoo_create_field` - `x_estimated_total_cost`, `x_estimated_gross_profit`,
`x_estimated_profit_margin` - against a request that asked for them to be
"computed fields... recalculate automatically when order lines, quantities,
product costs, or sales prices change". The task reported success, and the
RPC calls genuinely did succeed: each returned a field id, exactly as
`odoo_create_field`'s contract promises.

But `odoo_create_field`'s schema (`ODOO_CREATE_FIELD_SCHEMA`,
`tool-schemas.ts`) has no `compute`, `depends` or formula parameter of any
kind - it creates a plain stored column. The three fields were, by
construction, empty static columns with nothing making them compute
anything. "Computed, recalculated automatically" was never built. Nothing
in the lifecycle ever checked that part, because `validateOdooOnline`'s
entire prior behaviour was:

> There is nothing to run. Odoo validated each write as it applied it... and
> there is no repository test suite to run against a live instance.

True to its word, but it meant a schema change's *behaviour* - as opposed to
its *validity as an RPC call* - was never checked against anything. The
person then asked for sample data to verify it themselves (task_551621,
addressed separately by ADR-093), which surfaced the gap: there was no
existing mechanism in the platform that checked a built feature actually
does what was asked, for any Odoo Online task, ever.

The person's own framing, once this was explained: "sekarang kalo ada task,
bikin fitur atau apapun itu, harus ada hasil testingnya juga" - every task
that builds a feature should carry a real test result, not just a record
that the writes were accepted.

## Decision

`validateOdooOnline` (the `testing` state, odoo_online only) now runs a
second pass of `ModelImplementationLoop` in a new `'verify'` mode, after a
successful implementation, before completing the task:

- **Tools**: the same permission-gated set as implementation, minus
  `odoo_create_field`, `odoo_create_model`, `odoo_add_field_to_view`
  (`VERIFY_EXCLUDED_TOOLS`). A verification pass must not silently become a
  second implementation pass; withholding the schema-write tools makes that
  true by construction rather than by instruction alone.
- **Instruction** (`ODOO_ONLINE_VERIFY_INSTRUCTION`): asks the model to
  create one or two sample records with plain, hand-checkable numbers
  (`odoo_create_records`), read the built field back (`odoo_search_records`),
  and compare it to arithmetic it states explicitly in its summary - not to
  just assert a match. For an Automation Rule or Server Action, it asks the
  model to use an open browser session to trigger the behaviour and observe
  the effect. It closes with one of three explicit verdicts: `VERIFIED`,
  `FAILED`, or `NOT VERIFIABLE` (with the reason).
- **Verdict parsing** (`parseVerificationVerdict`, exported and unit-tested):
  reads the closing line for the verdict word. Checks `NOT VERIFIABLE`
  before `VERIFIED` so a careless "not verified" cannot accidentally read as
  a pass; anything matching neither recognised word falls through to
  `skipped` rather than being misread either way.
- **Outcome**:
  - `VERIFIED` -> the task completes, with the verification's own summary
    (the numbers it checked) narrated and recorded as a `passed` suite.
  - `FAILED` -> the task **fails** at the `testing -> failed` edge (already
    legal in the state machine), with the verification's finding as the
    failure reason. This is the one case where `testing` fails an
    already-applied, already-approved Odoo Online change: the writes
    happened and Odoo accepted them, but what they do does not match the
    request, which is exactly the class of problem this step exists to
    catch.
  - `NOT VERIFIABLE`, or the project granting none of
    `database_record_write`/`database_record_read`/`browser_control` at
    all, or the verification pass itself erroring/timing out/needing an
    unexpected approval -> the task still **completes**, recorded as a
    `skipped` suite with the reason. A capability the project was never
    granted is not this task's failure, and a verification pass breaking on
    its own account must never overturn a change that was already correctly
    applied and approved - a person seeing their approved change reported as
    failed over the *checker's* trouble, not the change's, would be strictly
    worse than this ADR not existing.

`TaskTestResults.suites[].status` gained `'skipped'` as a third value
alongside `'passed'`/`'failed'` (`agent-plan.ts`), and the frontend
(`task-inspector.tsx`, `lib/types.ts`) renders it with the same `idle` tone
the top-level skipped count already used, rather than reading as a failure.

## Consequences

- Every Odoo Online `change` task that reaches `testing` now makes one
  additional model call, with its own token cost, before completing. This is
  deliberate: the person explicitly asked for a verifiable result, not a
  cheaper one.
- A project with `database_record_write`/`database_record_read` enabled (the
  common case, and now the default recommendation for any project doing
  Odoo Online schema work - see ADR-093's related permission change) gets
  real, numeric verification for most computed-field requests. A project
  with only `browser_control`, or neither, gets an honest `skipped` instead
  of a false `passed` - which is strictly better than ADR-094 not existing,
  even for a project that cannot be verified today.
- Does not retroactively verify or fix task_837942's three existing empty
  fields - those remain static columns until a future task rebuilds them
  with an actual compute mechanism (Studio's formula editor or an Automation
  Rule, both reachable only through the browser since `odoo_create_field`
  still has no formula parameter). This ADR prevents the *next* such task
  from reporting the same false success; it does not repair the one that
  already happened.
- `parseVerificationVerdict` trusts the model's own stated verdict rather
  than independently re-deriving pass/fail from the tool log the way
  `CHANGING_ODOO_TOOLS`/`applied` does for "did anything change at all". A
  model that performs a real check but states the wrong verdict word is a
  risk this design accepts, the same way a model's implementation summary
  is already trusted for narration (though never for "whether a write
  happened", which `applied`/`CHANGING_ODOO_TOOLS` still governs
  independently).
- Tests: `model-implementation-loop-verify-mode.spec.ts` (new, 4 cases,
  `offeredTools` tool-filtering by mode) and
  `agent-workflow-verification-verdict.spec.ts` (new, 7 cases,
  `parseVerificationVerdict` including the NOT-VERIFIABLE-before-VERIFIED
  ordering and the case-sensitivity that keeps a casual mention of the word
  "verified" in prose from being read as a verdict).
