# ADR-083: The agent can read history, and a task can deliver commits it did not make

- Status: Proposed
- Date: 23 October 2026
- Milestone: Phase 5 (agent reliability)
- Builds on: ADR-018 (task state machine), ADR-021 (push safety), ADR-041
  (auto-push for non-production targets), ADR-060 (a push is verified before it is
  reported), ADR-062 (a task can pull), ADR-082 (a plan that names no file is
  answered)

## Context

Two questions reached the platform on the same day, and neither had an answer.

**1. "Is this pushed?"** — `task_599312`, project Omnisurge, branch `Staging`.
The task settled `completed` (ADR-082 had just made that possible) with this
answer:

> *"Status terkini: branch Staging bersih, `git_status` 0 file berubah,
> `git_diff` 0 file/baris berbeda dari base `1821f96e`. Artinya tidak ada commit
> lokal yang menunggu push. … saya tidak punya alat `git_push` atau `git_log`
> untuk membandingkan langsung dengan HEAD remote di GitHub."*

The conclusion was wrong. `git rev-list --left-right --count origin/Staging...Staging`
answered `0 2` - two commits ahead, twenty-one behind. The model was not careless:
the offered Git surface was `git_status`, `git_diff`, `git_pull`. `git_diff`
compares the working tree to the **workspace base commit**, so a clean tree says
nothing about the remote, and nothing else could look at `origin/<branch>` at all.
The tool set could describe the sandbox and not the destination.

**2. "Push what is already committed."** — the operator's actual request for two
days. There was no path:

- `git_commit` and `git_push` are `availableToModel: false` by design (ADR-021);
  the model may not commit or push.
- `validate()` completed a clean tree with *"The working tree is unchanged: there
  is nothing to commit or push."* A task whose whole purpose was to send commits
  that pre-date it therefore settled **`completed`** having pushed nothing - a
  false success, which is worse than a failure because nobody looks again.
- `commit()` would have called `git_commit` on an empty index and failed with
  "nothing to commit"; `push()` sends `snapshot.commitHash`, the commit the task
  itself made, so a task that made none had nothing to send.

The work landed in the end by hand (`git rebase origin/Staging` in a temporary
worktree, `5d4fa03..d648c88`), which is the proof of what the platform was
missing: not a phrasing, a capability.

## Decision

### 1. `git_log` is a real, offered, read-only tool

`RealGitTools.gitLog` (`backend/src/agent/tools/real/git.tools.ts`) with
`permission: repository_read`, `leavesPlatform: false`, `availableToModel: true`.
It returns:

- `commits`: the last `limit` (default 20, max 50) commits of the task branch -
  full hash, short hash, subject, author, ISO date;
- `upstream`: `{ ref: 'origin/<branch>', ahead, behind, diverged, asOf }`, or
  `null` with a note when no tracking ref exists;
- `localOnly`: the commits reachable from the branch and not from
  `origin/<branch>` - `git log <branch> --not origin/<branch>`.

`GitService.log()` takes the `exclude` ref for exactly that query and **throws**
on a ref git refuses, rather than returning an empty list: empty reads as "no
commits", the opposite of what a wrong name means. `GitService.resolveRef()` is
the nullable sibling of `revParse` for "does this tracking ref exist?".

The counts are against the **last fetch**, and both the tool description and the
result say so - a stale `origin/<branch>` must not be read as the remote's current
state.

### 2. A plan declares what it delivers: `delivery: 'commit' | 'push_existing'`

`plan-schema.ts` gains the field, defaulting to `'commit'`. `'push_existing'`
means: this request sends commits that already exist, nothing is authored. The
planner is told when to set it (push requests, in either language) and when not
to - a request that also asks for new work is an ordinary `change`.

Defaulting to `'commit'` is the safety property, not a convenience: a task
standing on a clean tree with commits ahead is **never** silently turned into a
push. A plan persisted before this field existed reads as `'commit'`.

### 3. `validate()` reads the plan and the ahead count, not the clean tree alone

A clean tree now has three outcomes instead of one:

| Plan | Tree | Ahead of `origin/<branch>` | Outcome |
| --- | --- | --- | --- |
| `push_existing` | clean | > 0 | `testing -> committing` ("Preparing the push") |
| `push_existing` | clean | 0 | `completed`: already at the remote tip, nothing pushed |
| `push_existing` | clean | unknown (no tracking ref) | `completed`: nothing was pushed, and says why |
| anything else | clean | any | unchanged: `completed`, "nothing to commit or push" |

The last row is what keeps ADR-082 inspections from pushing: an inspection also
runs with a clean tree, so the routing cannot be inferred from the status.

### 4. `commit()` does not author a commit that already exists

For a `push_existing` plan on a clean tree, `commit()` reads `HEAD`, records it as
the task's commit hash (the commit the task settles at - the column has always
been read that way by `push()` and the ADR-081 report), narrates it, and then
takes the **unchanged** approval path: `git_push` approval rows, `GIT_PUSH_ENABLED`
at the process layer, ADR-041 auto-push for non-production targets, ADR-054 backup
before a staging promotion, and ADR-060 verification inside the tool - which
compares local HEAD, the recorded commit, and the remote's branch tip, and refuses
to report delivery unless all three agree.

The tree, not the plan alone, decides whether to commit: a `push_existing` plan
whose model nevertheless wrote something is committed like any other task, so work
is never left behind because the plan said not to.

### 5. The approval record says what is being approved

`commitMessage` is omitted from the approval context when the task authored no
commit, rather than showing the message of a commit it did not write. The push
tool's mismatch error now says "the commit it settles at" instead of "its commit",
because for a `push_existing` task the tip is real and not authored here.

## Consequences

- A push of pre-existing commits is a normal task: plan -> approval -> push, with
  the ADR-060 verification intact. What changes is who made the commit, not what
  is checked before delivery is claimed.
- `agent_tasks.commit_hash` on a `push_existing` task is the **delivered tip**, not
  a commit this task wrote. Nothing in the platform claims authorship; the report
  says the commit was pushed, which is true. A future "who authored this" question
  reads the commit itself, not the row.
- A diverged branch still fails at the push, with git's own refusal. Rebase is not
  a capability and this ADR does not add one: the tool surface stays
  fast-forward-only (ADR-062), and the task settles `failed` naming the reason.
- The portal does not render `delivery` on the approval screen. The plan's summary
  and steps carry it, and the file list is empty by design; a badge is UI work, not
  a decision.
- `git_log` is offered to change and chat tasks alike wherever a repository
  exists (`modes: odoo_sh | on_premise`). It reads, never writes, and its `limit`
  is bounded because tool results are published to every subscribed browser.

## Verification

- `backend/src/agent/git/git-log.spec.ts` - real git against a real local remote:
  ordering, the `limit`, `--not <tracking>` returning exactly the local-only
  commits, ahead/behind counts, a missing ref throwing, `resolveRef` returning
  null.
- `backend/src/agent/orchestration/push-existing-commits.spec.ts` - the schema
  (accepts `push_existing`, defaults to `commit`, refuses anything else), the
  workflow routing (route to `committing` only with ahead > 0; honest completion
  when already at the tip; `git_commit` not called on a clean tree; an ordinary
  clean task still completing instead of pushing), the tool registration, and a
  real push that delivers a commit the task never made.
- `npx jest` - 114 suites, 1313 tests green. `npx tsc --noEmit` clean. `nest build`
  emitted; `dist/agent/orchestration/agent-workflow.js` carries the new routing.
- Live estate, same day: the manual equivalent succeeded for the same branch -
  `git rebase origin/Staging` then `git push` (`5d4fa03..d648c88`), verified by
  `git ls-remote` and by reading both files out of the remote tree.
