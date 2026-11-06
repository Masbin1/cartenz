# ADR-095: One toggle-free task mode, testing always runs

- Status: Accepted
- Date: 6 November 2026
- Milestone: Phase 5 (connected-server estate)

## Context

The person's own framing: "kita hilangkan juga deh chat dan change di odoo on
premise dan juga odoo sh, jadi by context promtingnya aja... sama untuk
testingnya harus selalu berjalan mau apapun itu odoonya, mau odoo on
premise, odoo sh dan odoo online ya" - no manual Chat/Change toggle on any
project type, the prompt's own content decides; and testing must always run
regardless of which Odoo hosting the project uses.

ADR-088 built the "decide from the prompt" half, but only for Odoo Online,
for a specific reason recorded in its own text: on a repository-backed
project (odoo.sh, on-premise), `chat` skipped validation entirely - `change`
ran it, `chat` did not - so a misclassified prompt there would silently land
an untested change, which is a materially worse outcome than Odoo Online's
"one extra inline approval". That asymmetry is what this ADR had to remove
before the classifier could be extended safely.

Two gaps in `agent-workflow.ts` made `chat` skip validation:

1. `implementChat`: when a chat task's approved write produced files (`wrote
   === true`) on a non-`main` branch, it transitioned straight
   `implementing -> committing`, bypassing `testing` - and therefore
   `validate()` - entirely.
2. `completeChat` (the `testing` state for chat): transitioned straight
   `testing -> completed` unconditionally, never calling `validate()` even
   when the task had, in fact, written files (reached here through the
   other, `main`-branch path, which did pass through `testing` but did
   nothing there).

Both were deliberate when written - ADR-029's own words:
"Chat used to skip the test run that change does not" - not oversights. They
just made the Chat/Change distinction load-bearing for correctness in a way
that a text classifier's occasional wrong guess could not be allowed to hit.

## Decision

**Validation gap closed first** (the precondition for the rest):

- `implementChat`'s write branch now transitions `implementing -> testing`
  (with the same file-count/diff-stats narration a change task's write
  already used), instead of `implementing -> committing`.
- `completeChat` now checks the workspace: if it is a real repository
  (`!workspace.simulated`) and `git status` is not clean, it delegates to
  `validate(snapshot)` - the exact function a change task's `testing` state
  calls - instead of completing unconditionally. A chat that only answered,
  with a clean tree, still completes immediately: there is nothing for
  `validate()` to check, and running it anyway would ask the repository's
  test runner to grade a diff that does not exist.

`validate()` itself needed no changes: it already reads `snapshot.plan?.…`
with safe defaults (`validation ?? ['run_linter']`, `delivery ?? 'commit'`),
so it tolerates a chat task's absent plan exactly as the optional chaining
was already written to allow.

**Classifier then extended**: `TaskKindClassifier` (ADR-088) is no longer
odoo_online-only. `tasks.service.ts` calls `classify()` for any task that
did not name a `kind`, on every project type - the `project.projectType ===
'odoo_online'` guard is gone. The classifier's own prompt was generalised
from "a live Odoo Online instance" to also recognise a codebase (module,
file, function, automation rule, test), since odoo.sh/on-premise requests
are about source code rather than live records.

**Frontend**: the Chat/Change `ModeButton` toggle in the composer footer is
removed for every project type (it was already hidden for odoo_online since
ADR-088); task creation always omits `kind`, letting the server classify.
The static hint text below the composer, which used to read the local
`kind` UI state, is replaced with wording that describes both outcomes
without claiming to know which one the server will pick. The "Target
environment" select is untouched - it remains only for odoo_online, where
ADR-021/038 already established it is a single meaningless placeholder; for
odoo.sh/on-premise it still picks a real branch/environment and stays
visible.

## Consequences

- A misclassified prompt on any project type now costs, at most, one
  additional inline approval moment or - worse case - a test that runs and
  catches a problem a `change` task's plan review would have caught earlier.
  It can no longer silently skip validation on a repository-backed project.
- A chat conversation that writes files is now charged the same validation
  step a change task already was, including a real Odoo test run where
  `ValidationRunner` is configured (ADR-027) - not only the simulated
  fallback. This is a deliberate cost increase for a chat write, in exchange
  for the testing guarantee the person asked for.
- `completeChat`'s workspace/git-status check means every chat task now
  acquires its workspace even when it never wrote anything, where it
  previously could complete without touching git at all for an answer-only
  conversation on a repository-backed project. The cost is one `git status`
  call, not a clone - the workspace itself is already allocated by the time
  `testing` is reached, same as any task that got this far.
- Tests: `tasks.service.spec.ts`'s ADR-088 suite (renamed to credit ADR-095)
  gained cases asserting `classify()` now runs on odoo.sh and on-premise, and
  two of its other suites (main-branch restriction, the ADR-041 repository
  check) needed a working `classify` stub added, since those now call it
  too, on project types whose `TaskKindClassifier` mock was previously `{}`.
