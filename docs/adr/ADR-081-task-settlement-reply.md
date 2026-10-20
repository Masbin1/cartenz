# ADR-081: The reply is composed from what the task did

- Status: Accepted
- Date: 20 October 2026
- Milestone: Phase 5 (review)

## Context

The operator reported, verbatim: "kalopun tugas berhasil harusnya respon di
chatnya adalah hasil dari pekerjaannya ... kalo ngubah code, yaudah gak dapet
respon yang bagus, cuma di kasih tau kalo udah di push aja codenya."

The cause, confirmed against a real task (`task_976297`, the Omnisurge trip-KPI
dev task): only a `chat` task ever calls `TaskRepository.saveAnswer()`. A `change`
task's model-written summary (`ModelImplementationLoop`'s `outcome.summary`) was
narrated to `agent_actions` via `narrate()` - the Activity tab - and never saved
to `agent_tasks.answer`, which is the column the thread reads. The only thing
that ever reached `answer` for a change task was `transition()`'s
`coalesce(answer, message)` on reaching a terminal status, and `message` there is
a one-line status sentence, not a report:

- a successful push: "Branch Staging was pushed to the remote repository at
  commit 4e389b49." - no file named, no validation result, no plan;
- a failed push: the `failureReason`, which for `task_976297` was git and SSH's
  raw stderr, host-key notice included, with no file list and no commit either
  side of it;
- `completed`/`failed` reached with no `message`/`failureReason` at all left the
  thread with nothing.

The person asked for work and was told where it went (or that it did not), never
what it was.

## Decision

### 1. One pure composer, not a template per call site

`backend/src/agent/orchestration/task-report.ts` exports `composeTaskReport(facts,
settlement)`. It is pure - no database, no clock - so what a person is told is
testable without running a task. It takes:

- `TaskReportFacts`: the model's report (`body`), the plan summary, the files git
  changed (`ModifiedFile[]`), lines added/removed, a pull result, test results,
  the commit hash and branch - everything already persisted on the task row by
  existing `save*` calls;
- `TaskSettlement`: the outcome (`completed`/`failed`), the status the task
  settled *from*, and the transition's own `message`/`failureReason`.

`reportFactsFromTask(row)` reads these off a plain `agent_tasks` row, tolerating
older or partial jsonb shapes rather than throwing.

### 2. Facts come from the platform's own record, never from prose alone

A claim appears only when the fact behind it exists:

- files are listed because `ModifiedFile[]` (git's diff, not the model's account)
  says so, with their own line counts;
- "pushed to `<branch>`" is stated only when the task settled *from* the
  `pushing` (or `building`) status - `transition()`'s own state, not a string
  match on the message;
- a push that failed after the commit landed says the commit exists and did not
  reach the remote, so "redo it" and "push it again" are distinguishable;
- simulated validation is reported as simulated, matching the existing rule that
  a simulated pass is not evidence;
- the model's own summary is the body when there is one; the approved plan's
  summary stands in when there is not (e.g. a failure before the model reported
  anything).

### 3. Composed once, at the moment of settlement

`TaskRepository.transition()` calls a new private `composeSettlementReport()`
when `to` is `completed` or `failed`, immediately before applying the patch - the
row it reads is the one about to transition, carrying every `save*` call the step
already made (`saveModifiedFiles`, `saveDiffStats`, `saveTestResults`,
`saveCommitHash`). It returns one of three things:

- a composed string, written to `answer`;
- `'keep'`: a chat task that only answered (no write, no commit) keeps its answer
  exactly as the model wrote it - a plain conversational reply should not be
  decorated into a status report;
- `null`: the row could not be read, so the caller falls back to the previous
  `coalesce(answer, message)` behaviour. A reply is never worth a stuck task.

`AgentWorkflow` additionally calls `saveAnswer()` at two points that used to skip
it entirely, so the composer has a model report to lead with instead of only the
plan summary:

- `implement()` (the repository change loop), once git confirms work exists (a
  changed file, or a pull) - never over an empty diff, which is exactly the
  claim the existing gate below it exists to catch;
- `implementOdooOnline()`, after the tool log (`applied`) confirms at least one
  change actually landed on the instance.

`implementChat()` already called `saveAnswer()` for a plain answer; that is
unchanged.

### 4. One language, chosen the same way the model is already told to choose it

`reportLanguage(prompt)` picks Indonesian or English by marker-word count,
defaulting to Indonesian on a tie - the same rule the chat, planning and
implementation instructions already state for the model. The platform's own
lines (`**Selesai**`, `**Files changed**`, …) follow it, and a settlement message
written in English by another part of the platform (`"Pushing is disabled on
this server"`, `"applied to the Odoo Online instance"`, …) is translated by
pattern rather than passed through, so a reply does not end in a sentence
switching languages mid-way.

## What is deliberately not done

- **A fixed report template the model must emit.** The model's own prose is kept
  verbatim as the body; the composer adds facts around it rather than replacing
  it with a rigid shape. A model that explains a trade-off in its own words keeps
  doing so.
- **Re-deriving facts the task did not persist.** If `testResults` is null
  because validation never ran, the reply says nothing about tests - it does not
  infer "no tests exist" or similar.
- **Changing `agent_actions`/the Activity tab.** Every narrated line still lands
  there exactly as before; this ADR only changes what ends up in `agent_tasks.answer`,
  which is what the thread renders.

## Consequences

- A change task's reply, success or failure, now names the files git changed,
  their line counts, the validation outcome, and the commit/push state - the
  reviewer-level detail "Branch Staging was pushed ..." never carried.
- A failed push shows the commit it stopped behind and the git reason, with SSH's
  host-key noise stripped, instead of a raw stderr dump.
- The two new `saveAnswer()` calls in `AgentWorkflow` add one each write per
  settling change task; negligible against the writes the step already makes.

## Verification

- `npx jest --testPathPattern="task-report"` in `backend/` passes
  (`task-report.spec.ts`: the pure composer; `task-repository-settlement-report.spec.ts`:
  wired through `transition()`).
- `npx jest` in `backend/` passes in full (111 suites, 1287 tests).
- Replayed against `task_976297`'s actual recorded facts (prompt, plan, modified
  file, commit, failure reason): the composed reply names
  `linkederp_dashboard_api/docs/delivery-trip-kpi-dev-task.md`, the commit
  `4e389b49`, and "did not reach the remote" with the non-fast-forward reason -
  where the live task showed only the raw git/SSH stderr.
- Live: submit a change request against a connected project. The completed (or
  failed) reply in the thread names at least one file, and a push failure names
  the commit instead of showing bare git/SSH output.
