# ADR-082: A plan that names no file is answered, not failed

- Status: Proposed
- Date: 23 October 2026
- Milestone: Phase 5 (agent reliability)
- Builds on: ADR-018 (task state machine), ADR-062 (an empty diff can be a
  success), ADR-081 (the reply is composed from what the task did)

## Context

The operator asked the platform to look at something, not to change it:

> *"apakah kamu bisa cek commit nya?"* — `task_679338`, project Omnisurge,
> branch `Staging`

The task produced a correct answer and was then reported as a failure:

```
Gagal di tahap implementasi.
The agent reported completion but made no change to the working tree.
```

Both halves of that sentence are true, and together they are wrong.

The plan the operator approved named no file - `plan.filesToModify` was `[]`,
which `plan-schema.ts` permits deliberately since ADR-062 - and its summary said
so: *"Permintaan ini hanya meminta pengecekan status commit di branch Staging,
bukan perubahan kode."* The implementation run then did exactly the right thing:

```
git_status  -> {"clean": true, "branch": "Staging", "changedFiles": 0}
git_diff    -> {"files": [], "linesAdded": 0, "filesChanged": 0}
git_pull    -> failed: git fetch failed (exit 128): error: insufficient
               permission for adding an object to repository database
               .../.git/objects
```

and answered in Indonesian. `agent_tasks.answer` holds that summary
(`has_answer = t`) - so ADR-081's composer had a body to show - while
`agent_tasks.status` reads `failed` because `implement()` reaches:

```ts
if (modified.length === 0) {
  if (outcome.pulled) { /* ADR-062's success path */ }
  return this.tasks.transition(taskId, 'implementing', 'failed', {
    failureReason: 'The agent reported completion but made no change to the working tree.',
  });
}
```

`outcome.pulled` only covers a pull that reported success. A read-only *read*
has no such flag: its diff is legitimately empty, so the one branch that can
rescue an empty diff does not fire. The guard was written for a plan that named
files and produced none - the case it must catch - and it was applying to a plan
that never promised a change in the first place.

The same run shows why a person then calls the platform unreliable: the failure
banner sits on top of a correct answer, and the real obstacle (a root-owned
`.git/objects` directory that made the fetch fail) is buried in an Activity-tab
tool result.

## Decision

### 1. The gate reads the approved plan, not only the diff

`implement()` derives `readOnlyPlan` from `snapshot.plan?.filesToModify.length
=== 0` before it reads the diff. The comparison is deliberately `=== 0` and not
a falsy check: an absent plan (`undefined`) must keep the strict rule, because a
change task without a plan is a fault, not an inspection.

### 2. A read-only plan that produced an answer completes the task

When the diff is empty, the plan named no file, and the summary is non-empty,
the run saves the answer (`saveAnswer`, the same call a `chat` task uses) and
transitions `implementing -> testing`. `validate()` then finds a clean tree and
completes the task through the path a pull-only task already takes - the state
machine keeps `implementing -> completed` absent (ADR-018), so `testing` is the
route, not a shortcut around it.

An empty summary is still a failure. "Completed with nothing to read" is the
outcome `task_355199` hit on the chat side and it stays refused here for the same
reason: a visible failure is recoverable, a silent non-answer is not.

### 3. The strict rule is untouched where it was earned

A plan that named files and produced an empty diff still fails with the original
message. The guard exists because a model claiming edits over an empty diff is
worse than a visible failure, and nothing in this decision relaxes it: the new
branch sits *before* the failure and is selected by the plan, never by the
model's prose.

### 4. The prompts say what the deliverable is, on both sides of the approval

- `model-agent-planner.ts`: a request that asks for information rather than a
  code change (check, inspect, report, explain, list, review) MUST plan
  `filesToModify: []` with read-only steps, and say in the summary that the
  finding is the deliverable. Before this, only Git *operations* were allowed an
  empty list, so an inspection could still be planned with an invented file.
- `model-implementation-loop.ts`: a plan with an empty file list is "a pull or an
  inspection, and the summary you end with IS the deliverable there", replacing
  the pull-only parenthetical.

## Consequences

- An inspection request is a first-class task kind instead of a failure that
  happens to contain the right answer. The operator reads the finding in the
  thread and sees the task settled, not a red banner over a correct reply.
- The platform no longer spends a full run on a task it will declare failed at
  the last step, and the Activity tab's tool results stay the place to look when
  an inspection reports a real obstacle (a failed `git_pull`, a permission
  error), rather than being contradicted by the outcome.
- A read-only task now settles in `completed` with `modified_files = []` and
  `diff_stats.filesChanged = 0`. Anything reading "completed" as "a commit
  exists" must keep reading `commit_hash` instead; the pull path already
  established that shape (ADR-062).
- Deliberately out of scope: a plan that named a file which turned out to need no
  change (`task_680597`: the plan named `docs/USER_MANUAL.md`, the file already
  existed at the branch tip, the model refused to rewrite it). The honest outcome
  there is a finding too, but it is a different decision - the plan promised
  work - and it still fails.
- Deliberately out of scope: the `git fetch` failure in the same run. Root-owned
  paths inside `/opt/cartenz/.runtime/checkouts/<project>/repo/.git` are an
  operational defect on the host (a file written by a root-run `git`), not a
  property of the workflow. It is what makes a local commit unpushable, and it is
  fixed by taking ownership back, not by code.

## Verification

- `backend/src/agent/orchestration/read-only-plan-task.spec.ts` asserts the
  gate's selection (`planFiles === 0`, not a falsy test), the
  `implementing -> testing` transition inside the read-only branch, the
  no-answer failure that survives it, the untouched strict failure for plans that
  named files, and both prompt instructions.
- `npx jest src/agent/orchestration` - 12 suites, 117 tests green.
- `npx tsc --noEmit` clean; `nest build` produced `dist/` for the running API and
  worker.
- Against the live estate: the failing row is `task_679338`
  (`status = failed`, `plan->filesToModify = []`, `answer` non-null). A read-only
  request resubmitted after this change settles `completed` with the same empty
  diff.
