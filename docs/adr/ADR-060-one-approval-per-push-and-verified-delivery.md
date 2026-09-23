# ADR-060: One approval per push, and a push is not delivered until it is verified

- Status: Accepted
- Date: 23 September 2026
- Milestone: Phase 5 (connected-server estate)

Builds on ADR-011 (the orchestration contract), ADR-018 (the task state machine),
ADR-019 (per-task workspaces), ADR-021 (push safety and target environments),
ADR-041 (auto-push for non-production targets) and ADR-046 (a task works on the branch
a person chose).

## Context

A push on a real deployment produced three failures at once, and they were reported as
one symptom: *"kenapa selalu meminta approval untuk push lebih dari 1, harusnya cukup 1
aja dong, ini kadang 2 sampai 3 kali, kayanya ini yang menyebabkan errornyaa"*.

On `task_325475` the record shows what happened, in order:

```
09:28:17.457  git_commit completed                    → f59f2616
09:28:17.524  "Pushing Development-main to the remote without an approval:
               this deployment pushes development and staging work automatically
               (GIT_AUTO_PUSH_ON_TASK=true)."
09:28:17.545  task_status_changed → pushing
09:28:17.599  approvals INSERT  git_push  (pending)   ← the tool gate refused it
09:28:17.6xx  ERROR  Illegal agent task transition pushing -> waiting_approval
09:28:22.281  git push approved by bintang            ← approval #2
09:28:23.377  approvals INSERT  git_push  (pending)   ← asked again
09:28:28.295  git_push completed
09:28:28.345  task_completed  "Branch Development-main was pushed"
09:28:45.630  git push approved by bintang            ← approval #3, after the task ended
```

Three separate defects are visible in those eleven lines.

**1. The workflow and the tool gate disagreed about whether a push was approved.**
ADR-041 lets a deployment push `development` and `staging` work without a per-task
approval. The workflow acted on that decision and moved the task to `pushing`. The gate
that guards every operation leaving the platform (`permission-validator.ts`) reads
approval *rows*, found no `git_push` row, and refused the push the workflow had just
authorised — 40 ms after writing the line saying it was authorised.

**2. The refusal was fatal, and the retry is what produced the extra prompts.**
Suspending means `waiting_approval`, and `pushing` had no edge to it. The approval row
was inserted before the transition was attempted, so the prompt appeared in the UI; the
transition then threw, the BullMQ job died, and `attempts: 3` retried the whole step.
Each retry re-decided "no approval needed", re-refused, and re-asked. `request()` only
de-duplicated against a *pending* row, so an already-approved `git_push` was no obstacle
to inserting another one. One push, three authorisations, and a task reported as failed.

**3. A commit was reported as pushed that was never on the remote.** This is the one
that matters, and it was invisible until the remote was read directly. The commit was
made in the first job's workspace. That job died (defect 2), the run ended, and its
workspace was released. The resumption ran in a different job, cloned the remote afresh
— a tree that does not contain `f59f2616` — and pushed it. `git push` compared the
branch with the remote, found them identical, printed "Everything up-to-date", and
**exited 0**. The workflow read exit 0 as delivery and completed the task with "Branch
Development-main was pushed to the remote repository."

Reading the repository settles it:

```
$ git log --format='%h|%an <%ae>' origin/Development-main
59168d0|Mas Bintang <bintangbluzz@gmail.com>|09-23 10:02
c66929d|Mas Bintang <bintangbluzz@gmail.com>|09-23 09:34
0f1c2ea|Mas Bintang <bintangbluzz@gmail.com>|09-23 09:31
18e48f8|Mas Bintang <bintangbluzz@gmail.com>|09-23 09:18
```

Not one commit authored `LinkedERP AI Agent <ai-agent@linkederp.com>`. Every commit
the platform recorded as made (`f59f2616`, `e137b038`, `c34f5a7d`) is absent from the
remote. The operator's own commits are there; the agent's are not.

The common cause of all three is that the platform treated *its own intent* as evidence:
that a decision to push was a push approval, that a job ending was a workspace ending,
and that a command exiting 0 was work delivered.

## Decision

**One approval per push, recorded as a fact; and a push is verified against the remote
before it is reported.**

### 1. A deployment-granted approval is written down

`ApprovalService.autoGrant()` records the deployment's authorisation as a normal
`approved` row for `git_push`, with `decidedAt` set and the reason naming
`GIT_AUTO_PUSH_ON_TASK=true`. The auto-push path in `commit()` calls it *before*
transitioning to `pushing`.

It is written as a row rather than as a bypass the validator alone knows about, because
the row is what every reader consults: the permission validator, the workflow's
`grantedApprovals`, the list shown beside the task, and the audit trail answering "who
authorised this push". A bypass would satisfy the gate while leaving the record saying
nobody did.

### 2. `request()` de-duplicates against granted as well as pending

An approved approval for an action on a task is a live authorisation, so asking for it
again is asking a person to authorise what they already have. A *rejected* action is
deliberately not de-duplicated: a rejection is not an authorisation, and a task must be
able to ask again.

### 3. `pushing -> waiting_approval` exists

Added to the state machine as a backstop. Refusing the edge never prevented the
suspension — it only made it kill the job, which is what hid the workflow/gate
disagreement behind a crash and triggered the retries. A state machine whose refusal
ends the run must not be the reason a legitimate suspension cannot happen.

### 4. The resumption job id is derived from the decision

`resume(taskId, reason, approvalId)` uses the approval's id in the BullMQ job id. A
`Date.now()` suffix de-duplicated nothing: two enqueues of the same decision (a retried
request, a double-click, two processes) received different ids and both ran. Two
*different* approvals on one task still get two jobs, which is what the date suffix was
there to protect.

### 5. A workspace holding an unpushed commit is kept, and reattached

`releaseWorkspace` keeps the clone while the task is not terminal, and the
`agent_workspaces` row stays `ready`. `WorkspaceManager.allocate` reattaches to that
directory instead of cloning again, and only when `HEAD` is the commit the task recorded
— because a directory that has drifted is not evidence of that work.

The commit exists nowhere else at that moment: it has not been pushed, and the diff on
the task is a patch rather than the commit. Deleting the directory to save disk was
deleting the work.

### 6. `git_push` reads the remote back and fails closed

Three commits must agree before a task may report delivery: the one the task recorded
after committing, the local `HEAD`, and the tip of the branch on the remote.

The read-back alone is not sufficient, and this is the subtle part: a workspace
re-cloned from the remote has a `HEAD` *identical* to the remote's tip, so comparing
those two accepts a push of nothing. It is the recorded commit that tells the two apart.
The tool therefore takes the task's own commit as input (`GIT_PUSH_SCHEMA`), supplied by
the workflow — `git_push` is never available to the model — and refuses when the
workspace does not hold it.

On failure the workflow now carries the tool's explanation into `failureReason`, so the
task record says *why* rather than "The push did not complete."

## Consequences

- A development or staging push asks for **zero** approvals on a deployment with
  `GIT_AUTO_PUSH_ON_TASK=true`, and exactly **one** where a person must approve. The
  reference record for an earlier push is that this held for a task whose push was
  approved once (`task_991497`), and did not for one approved twice (`task_325475`).
- A push that delivered nothing is now a **failed** task with a reason naming both
  commits, rather than a completed task claiming success. This is a behaviour change
  operators will notice, and it is the point: the previous report was false.
- A workspace survives a suspension, so a task suspended at a push approval holds disk
  until it settles. A task abandoned at `waiting_approval` therefore holds its clone
  until it is cancelled — `reclaimOrphans` covers the crash case, but a long-lived
  paused task is now a long-lived directory. That is the correct trade: the alternative
  is a silently lost commit.
- Verification costs one additional `ls-remote` per push, against a remote the push has
  already contacted. It reuses the same credential lease, so no new credential path
  exists.
- `resume()` gained a required parameter. Any future `AgentOrchestrator` implementation
  (the Temporal one of ADR-011) must accept an approval identity, which it needs anyway
  to be idempotent.

## Alternatives considered

**Have the validator consult `git.autoPushOnTask` instead of an approval row.** Rejected:
the validator is a pure policy function over a context and holds no configuration; and
the push would then be authorised by nobody in the record, which is exactly the
question the audit trail exists to answer.

**Make the suspension from `pushing` fail loudly instead of adding the edge.** Rejected:
that is what it already did, and the consequence was three prompts for one push and a
retry loop writing duplicate approval rows.

**Verify the push in the workflow rather than in the tool.** Rejected: the credential is
unsealed in the tool layer and never leaves it (ADR-021). Reading the remote needs the
credential, so the check has to live where the credential already is.

**Keep the workspace only on the push path.** Rejected as the more complex option:
"should this run keep its clone" then depends on the state the run ended in, which is
precisely the coupling that produced the defect. Terminal is a simpler and more
defensible line.

**Compare the remote against the saved `commit_hash` alone.** Insufficient: the push can
legitimately be made from a workspace whose `HEAD` has advanced past the recorded commit
when a repair ran after re-validation. All three must agree, which is what the
implementation checks.
