# ADR-022 — Tool output fidelity and targeted edits

**Status:** Accepted
**Date:** 2026-08-28
**Supersedes in part:** ADR-020 §5 (which named targeted edits as future work)

## Context

The first task run against a real customer repository — a 12-module Odoo 19 addons
repository, `StagingDM` branch — produced a change that deleted **1043 lines** of working code
from a 1101-line module. The task reported success. Validation reported three passing suites. The
diff looked like a small addition until the line counts were read.

Nothing in the test suite failed, before or after. That is the part worth dwelling on.

### The defect

`ToolExecutionService.execute` did this:

```ts
const output = await tool.execute(request.input, request.context);
const redacted = redactMetadata(output);
// ... persist `redacted`, publish `redacted` ...
return { status: 'succeeded', output: redacted };
```

`redactMetadata` exists to make output safe to **store**: it strips credentials and caps
strings at 2048 characters so an audit row cannot become a megabyte. Both behaviours are correct
for that purpose.

Returning that same value to the caller made the truncation part of the agent's view of the
repository. `read_file` on a 43 KB file returned the first 2048 characters — 58 lines, the last
one cut mid-statement — and reported nothing wrong, because `truncated: false` was accurate: the
*tool* had not truncated. The filter had.

The scripted provider then did what it is supposed to do: read, append its block, and write the
whole file back through `update_file`. `update_file` replaces the entire file. So the file became
55 complete lines plus a comment block, and the other 1043 lines were gone.

### Why no test caught it

Every fixture file was under 2 KB. The largest was about 40 lines. Under 2 KB the filter
truncates nothing, so the read-write round trip was lossless in every test and lossy in
every real repository. The test suite was not weak; it was testing a repository that did not
resemble a customer's.

## Decision

### 1. The persisted copy and the returned copy are different values

`execute` returns the tool's actual output. The redacted copy is still written to the action
record, the event payload and the audit trail.

This does not weaken the data boundary. What protects a model from seeing something it should not
is the AI data boundary (ADR-020) — a separate chokepoint, applied in both directions, which is
unchanged. The audit filter was never the mechanism for that, and using it as one silently broke
the agent's ability to read its own repository.

`ToolDefinition`'s output type is narrowed from `unknown` to `Record<string, unknown>`, which is
what every tool already returned, so the service can return it without a cast.

### 2. `edit_file` becomes the way to change an existing file

A new tool takes an exact `find` string and a `replace` string, and requires the found text to
appear **exactly once**. Zero matches is a caller error; several is ambiguous, and both are
refused without writing.

This removes the failure class rather than bounding it: a tool that replaces only what the caller
quoted cannot delete a thousand lines the caller never mentioned. The model instruction now names
`edit_file` as the tool for existing files and `update_file` as a last resort.

Requiring uniqueness is a deliberate cost. Extending `find` with context lines is work the caller
must do. The alternative — replacing the first of several similar blocks — produces a change that
is wrong in a way a reviewer is unlikely to notice, which is worse than a refusal.

### 3. `update_file` refuses a destructive rewrite

A whole-file replacement that reduces a file of more than 40 lines by half or more is refused, and
the error names the tool to use instead.

The thresholds are judgement, not arithmetic. Files under 40 lines are plausibly rewritten on
purpose — a short `__init__.py`, a manifest, a stub view. Halving a large file is not something a
correct change does often, and when it is, `delete_file` then `create_file` states the intention
and carries an approval.

This is a bound, not a fix, and it is kept alongside `edit_file` for two reasons: it protects
callers not yet changed, including any future model, and it is the layer that held when the root
cause was temporarily reintroduced to test the regression suite.

### 4. A partial read is never written back

The scripted provider skips a file whose read was marked `truncated` and says why, rather than
appending to a fragment. `read_file` still truncates at `READ_FILE_MAX_BYTES` (256 KB), which is a
real limit for genuinely large files, and writing back a fragment of one would destroy it.

### 5. The fixture gains a file large enough to fail

`omnisurge_large/models/big_model.py` is 214 lines and 16 KB — eight times the filter's string
limit — and its last line carries `OMNISURGE_TAIL_MARKER`. A round trip that loses the tail is
now detectable by grep.

The repository smoke test asserts three things about a task against it: that no more than 20 lines
were deleted, that the marker survives, and **that the file was actually modified**. The third
matters: without it the section passes when the destructive-rewrite guard refuses the write and the
file is skipped, which is the guard working correctly but is not the round trip working.

## Consequences

The platform can read a file larger than 2 KB. That sentence should not have needed writing, and
that it does is the measure of how much a real repository was worth.

Costs: one more tool for a model to choose between, and `edit_file`'s uniqueness requirement makes
some edits take two attempts. The threshold in §3 will occasionally refuse a legitimate large
rewrite; the error names the alternative.

What this does not fix: the scripted provider chose `linkederp_dashboard_studio/models/dashboard.py`
for a change to `sale.order`, when the repository has
`linkederp_sales_modifier/models/sale_order.py`, which already inherits that model. The write path
is now safe; the *choice* of file is a matter of judgement the scripted provider does not have and
a configured model would. That remains open.

## Verification

| What | How | Result |
| --- | --- | --- |
| The guard refuses the exact failure | `write-safety.spec.ts` | 1101 → 68 lines refused; 8 threshold tests |
| `edit_file` cannot lose unquoted content | `write-safety.spec.ts` | 8 tests: absent, ambiguous, empty target, indentation, overlap |
| The filter still truncates, and still removes credentials | `tool-output-fidelity.spec.ts` | 3 tests |
| A 16 KB file survives the round trip | `smoke-test-repository.sh` §10b | +14/−0, marker intact, file modified |
| **The regression test fails without the fix** | Root cause reintroduced, suite re-run | FAIL with the defect, PASS with the fix |
| The real repository | `LinkedERP/Odoo`, `StagingDM` | **+11/−0**, previously +12/−1043; the 1101-line module intact |
