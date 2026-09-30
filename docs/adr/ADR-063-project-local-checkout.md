# ADR-063: A Connected Project Keeps One Local Clone, and Tasks Work From It

## Status

Accepted

## Context

A task's workspace clones the repository fresh, works in it, and deletes it
when the task ends (ADR-046). That is correct for writing code: every task
starts from the remote tip, so it can never build on a stale copy.

It leaves two gaps.

Between tasks, nothing on this host holds the project's code. What the portal
shows as "the modules in this repository" is the analysis recorded by the last
task that ran (`project_memory`), not the repository as it is now. When a branch
is updated upstream (a merge on GitHub or odoo.sh) and no task has run since,
the portal shows the old list and there is no way to see, from here, that
anything changed. An operator connecting an existing project reasonably expects
the code to be on this server and to match the remote; today it is not, and the
mismatch looks like the platform lost changes.

And every task downloads the repository again. On a project with several
environments, pointing three tasks at three branches means three full clones of
the same repository, on the same host, minutes apart.

## Decision

Each connected project gets **one** long-lived local clone, under
`PROJECT_CHECKOUT_ROOT` (default `/opt/cartenz/.runtime/checkouts`):

    $PROJECT_CHECKOUT_ROOT/<project id>/repo/

This is the behaviour of a developer's laptop: clone once, then choose a branch
and work, without downloading again.

1. Cloned automatically when a project is connected with a repository
   (best-effort: a failed clone never fails the connection itself). Full history
   and **every** branch in that one clone, so choosing another branch costs
   nothing afterwards.
2. The clone's own checkout is left **detached**. Git allows a branch to be
   checked out in only one working tree at a time, so a clone sitting on a
   branch would make exactly that branch unavailable to every task.
3. A task takes a **worktree** of this clone
   (`git worktree add <workspace>/repository <branch>`) instead of cloning. The
   worktree is removed when the task ends; the clone stays.
4. The branch a task works on is chosen through the existing target
   (environment) dropdown in the task chat, which already resolves to a branch
   (ADR-046). `main` remains unselectable (ADR-028).
5. Synced on request from the project page (`POST /projects/:id/checkout/sync`):
   fetch every branch, then fast-forward each declared branch that nobody is
   working on. A branch with a task's worktree, or with commits of its own, is
   left exactly where it is. Nothing is ever reset.
6. Every sync re-analyses the clone and records the result in `project_memory`
   with no task id, so the module list on the project page reflects the remote
   as of the last sync, not the last task.
7. Status (`GET /projects/:id/checkout`) reports, per branch: commit, remote
   commit, how many commits behind and ahead, dirty or not, whether a task holds
   it, history depth, last sync time.

### Two tasks on one branch

Refused, with a message naming the branch and the way out (wait, or target a
different environment). This is a fix rather than a restriction: two working
trees on one branch each build on the other's absence and push over each other,
and the commit that loses is gone. The per-task clone ADR-046 used had the same
race without anything to stop it.

### Fallback

The clone is an optimisation, never a prerequisite. A task whose project has no
clone yet, or whose deployment does not keep clones, clones for itself exactly
as before. A task that cannot refresh the clone first still starts, from what is
on disk, and says so. `PROJECT_CHECKOUT_REUSE=false` restores the old behaviour
for every task while leaving the clone for reading and syncing.

### Credentials

The clone uses the same resolution as a task (ADR-021, ADR-058, ADR-059): the
project's own override, then the connection's credential, then the
organisation's saved credential for the host. Never the host's SSH key. The
resolution was extracted from `TaskRepository` into
`agent/git/project-git-access.ts` so tasks and checkouts cannot drift apart.

### Safety

- The project id becomes a directory name; no branch name ever does. State files
  are per branch, named through `escapeSegment`, which replaces every character
  outside `[A-Za-z0-9._-]` and refuses `.`/`..`, so a ref from a repository can
  never introduce a path separator.
- A branch must be one the project knows (default branch or an environment's
  branch); arbitrary refs are refused before anything is created on disk.
- Fast-forwards go through `git update-ref` **with the old value**, a
  compare-and-swap: a branch that moved in between is not overwritten.
- A worktree record is dropped when a task ends (`git worktree remove`, then
  `prune`), and pruned again before any read of which branches are held, so a
  worker killed mid-task cannot pin a branch nobody can see.
- Only code is cloned. No database, no filestore, no customer data (ADR-019
  stays the boundary for running client code).
- Each sync is audited (`PROJECT_CHECKOUT_SYNCED`); re-analysis too
  (`PROJECT_CHECKOUT_ANALYSED`). No credential value is ever recorded.

### Disabled

Leaving `PROJECT_CHECKOUT_ROOT` empty disables the feature; the panel says so.
`GIT_CLONE_DEPTH` stays a task concern: this clone is always whole, because the
one thing it exists for is answering a question the tip alone cannot.

## Consequences

- The project page can answer "is this host's copy current?" at any time,
  without running a task.
- One download per project, not one per task; a task on an already-fetched
  branch costs a working tree, not a clone.
- A second copy of the code exists on disk and can be stale between syncs. That
  is shown, not hidden: the panel states the commits behind and the time of the
  last sync, and syncing is one click.
- Customer source code rests on the host for as long as the project exists - the
  retention `WORKSPACE_RETAIN_ON_FAILURE` refuses by default. Accepted here
  because a clone that dies with its task cannot be read at all.
- A task's workspace shares the clone's history, which is why the clone is whole.
  Per-task clones stay available (`PROJECT_CHECKOUT_REUSE=false`) for a
  deployment where that trade is unwanted.
- Syncing is on request, not scheduled; a webhook or timer can call the same
  service later without changing its contract.
