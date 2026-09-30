# ADR-062: A task can pull the branch it works on, and "nothing new" is a success

- Status: Accepted
- Date: 23 September 2026
- Milestone: Phase 5 (connected-server estate)

Builds on ADR-011 (the orchestration contract), ADR-018 (the task state machine),
ADR-019 (per-task workspaces), ADR-021 (push safety), ADR-028 (execution adapters),
ADR-041 (auto-push for non-production targets), ADR-046 (a task works on the branch a
person chose), ADR-049 (an instance pulls its own repository) and ADR-060 (one approval
per push, and a push is not delivered until it is verified).

## Context

A person asked for the obvious thing:

> *"tolong lakukan pull dulu di branch ini dong, kayanya ada updatekan terbaru"*
> — `task_700645`, project Omnisurge, branch `Development`

The task failed with:

```
The agent reported completion but made no change to the working tree.
```

Nothing was wrong with the request, the branch or the remote. Three independent defects
conspired, and each one alone was enough to fail the task.

**1. There was no way to pull.** The tool surface had `git_status`, `git_diff`,
`git_branch`, `git_commit` and `git_push` — every git operation except the one that only
moves work *inward*. The model's own summary states the position it was put in:

> *"Tool yang tersedia untuk saya (list_directory, search_code, read_file, create_file,
> edit_file, update_file, delete_file, git_status, git_diff, detect_odoo_version,
> list_modules) tidak mencakup operasi git pull/fetch/network — jadi tidak ada rencana
> implementasi yang bisa dibuat untuk request ini."*

**2. `filesToModify` required at least one file.** `plan-schema.ts` declared
`z.array(plannedFileChangeSchema).min(1).max(20)`, so a request with nothing to change on
disk had no valid plan. The planner did the only thing the schema left it: it invented a
file and labelled the invention in its own reason field.

```json
[{"path": "dowgroup_sale_target/models/sale_target.py",
  "change": "modified",
  "reason": "Placeholder wajib skema — TIDAK ADA perubahan file yang direncanakan.
             Request ini bukan permintaan kode, jadi tidak ada file yang benar-benar
             perlu diubah; entri ini hanya memenuhi minItems schema dan harus ditolak
             saat implementasi."}]
```

A person approved that plan — the portal displayed a fabricated file as work to be done —
and the implementation model correctly refused to write it.

**3. An empty diff was a failure.** After implementation, `implement()` read
`git diff` and failed the task when nothing had changed. That guard exists for a good
reason (a model that claims work it did not do is worse than a visible failure), and it
is exactly wrong for a pull: the correct outcome of "pull the latest changes" when there
is nothing new is *no file change at all*.

The three compound: the tool was missing, so the planner had nothing to plan; the schema
forbade an empty plan, so it fabricated one; and the fabricated plan could not be carried
out, so the empty diff was read as the model's failure rather than the schema's.

## Decision

**A task may pull the branch it works on, as a tool the model is offered, and a pull that
finds nothing new completes the task.**

**1. `git_pull` is a real, offered tool.** `GitService.pullFastForward` fetches one branch
into the workspace's clone and merges it with `--ff-only`, and nothing else: no rebase, no
merge commit, no `-X theirs`. `git_pull` exposes it with `permission: repository_write`,
`leavesPlatform: false`, `availableToModel: true`, and the modes `odoo_sh` and
`on_premise`.

**2. A refusal is a refusal, not a resolution.** Two conditions are refused before the
branch can move:

- **A dirty working tree**, checked before anything is fetched. git would fast-forward
  around unrelated local edits, but a pull that sometimes proceeds and sometimes refuses
  depending on which files the remote touched is harder to reason about than one that
  always wants a clean tree — and the implementation instruction asks for the pull first.
- **A divergence.** `--ff-only` fails, `git` leaves the branch where it was, and the tool
  reports the refusal in words naming the two commits and the fact that a person must
  reconcile them. Resolving a divergence decides whose work wins, and no person is in this
  loop to make that call.

Credentials follow ADR-021, ADR-058 and ADR-059: the project's stored connection, unsealed
at the moment of the fetch and never taken from a host SSH key.

**3. "Up to date" is success.** `pullFastForward` returns `up_to_date` (the remote's tip is
already the branch's) or `fast_forwarded` (the branch moved, with the count and the file
names). Both are success, and the second is *work* even though no file differs from what
the plan expected.

**4. An empty `filesToModify` is the honest plan for a request with no file change.**
`plan-schema.ts` relaxes `min(1)` to `min(0)`, and the planner's instruction says so
explicitly: a pull-only request plans `filesToModify: []` and must never name a placeholder
or an example file, because a person approves exactly what is listed. The portal renders an
empty list as "No files change" with the reason, rather than as an empty box.

**5. The no-change gate accepts a successful pull.** `ModelImplementationLoop` records the
last successful `git_pull` on its outcome; `implement()` completes the task when the diff is
empty *and* a pull succeeded, and still fails it when the diff is empty and nothing was
pulled. The pull path reaches `testing` and then `completed`, never `committing`: there is
nothing to commit, and a push of nothing is what ADR-060 was written to stop the platform
reporting as a delivery. `validate()` completes rather than falling through to `git_commit`
when `git status` reports a clean tree, for the same reason.

**6. A pull is not offered in a conversation.** `git_pull` is refused by the permission
validator in a `chat` task, before any approval question, and is filtered out of the tools
the chat loop offers. A chat workspace is a throwaway clone whose changes are read back as
the chat's own writes (ADR-053); pulled commits would be mistaken for an approved edit and
committed as one.

## Consequences

- A pull-only request produces a plan with no files, one approval, an honest summary
  ("`Development` was already up to date with the remote; nothing to pull" or "Pulled 2
  commit(s) into `Development`"), and `completed`. The same task re-run against a remote
  with new commits reports the commits pulled.
- `filesToModify: []` is now reachable in the portal's approval screen. The plan view
  explains it instead of showing an empty list.
- The pull does not touch the task's `baseCommit`, so a pull that moves the branch and a
  subsequent code change in the same task both diff correctly against the base the task
  started from. The pulled commits appear in the diff as the base's absence — a person
  reviewing sees the remote's commits and the agent's commits in one place, which is what
  happened.
- `git_pull` is offered to the model in **every** change request, not only pull-shaped ones.
  This is deliberate: the same prompt sentence that lets a pull-only task work lets a code
  change start from the latest code, which is what a person asking for a pull first wanted
  anyway.
- The state machine is unchanged. `implementing -> testing -> completed` already existed for
  a task with nothing to commit (a chat that only answered); a pull-only task is that same
  shape. No new status, no new edge, no new approval action.
- `GIT_PULL_ENABLED` does not exist. Unlike push, a pull writes nothing outside the
  platform: a fetch sends no repository content out, and the branch only moves forward to a
  commit the remote already holds. There is no server-wide switch to add because there is
  no outward effect to forbid.

## Alternatives considered

**`git fetch` only, leaving the branch alone, and let the agent work on `origin/<branch>`.**
Rejected: the request was to update the branch, and a task that fetches without updating
leaves the person's branch exactly as stale as they complained it was.

**`git pull --rebase` or a merge with conflict resolution.** Rejected: both make a decision
about whose work wins. A model loop has no basis for that decision and no person in it to
ask.

**Make the planner produce a plan even for a pull-only request by planning the git
operation as a "file change" to `.git`.** Rejected outright: it is the placeholder defect
in a different costume, and it would show a person a path that does not exist.

**Complete the task directly from `implement()` without passing through `testing`.**
Rejected: `implementing -> completed` is deliberately absent from the state table, and it is
absent for a reason (ADR-028 — the Odoo Online path wrote to a live instance three times
because an illegal transition threw after the write). A pull-only task takes the same route
a chat that only answered takes.

**Let the post-implementation diff decide alone, treating *any* empty diff as success.**
Rejected: that removes the guard that catches a model claiming work it did not do. The gate
accepts an empty diff because a pull is recorded, not because the diff is empty.

**Offer `git_pull` in chat as well, gated behind an approval.** Rejected: the problem is not
authorisation, it is that a chat's writes are read back as the conversation's own edits.
An approval would make the commit legitimate, not correct.
