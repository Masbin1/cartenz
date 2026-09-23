# ADR-063: A Connected Project Keeps a Local Clone That Syncs on Request

## Status

Accepted

## Context

A task's workspace clones the repository fresh, works in it, and deletes it
when the task ends (ADR-046). That is correct for writing code: every task
starts from the remote tip, so it can never build on a stale copy.

It leaves one gap. Between tasks, nothing on this host holds the project's
code. What the portal shows as "the modules in this repository" is the
analysis recorded by the last task that ran (`project_memory`), not the
repository as it is now. When a branch is updated upstream (a merge on GitHub
or odoo.sh) and no task has run since, the portal shows the old list and there
is no way to see, from here, that anything changed. An operator connecting an
existing project reasonably expects the code to be on this server and to match
the remote; today it is not, and the mismatch looks like the platform lost
changes.

## Decision

Each connected project gets a long-lived local clone per branch, under
`PROJECT_CHECKOUT_ROOT` (default `/opt/cartenz/.runtime/checkouts`):

    $PROJECT_CHECKOUT_ROOT/<project id>/<escaped branch>/

1. Cloned automatically when a project is connected with a repository
   (best-effort: a failed clone never fails the connection itself).
2. Synced on request from the project page (`POST /projects/:id/checkout/sync`):
   fetch + fast-forward only. A divergent or locally modified clone is refused,
   never reset, so nothing is ever silently discarded.
3. Every sync re-analyses the clone and records the result in
   `project_memory` with no task id, so the module list on the project page
   reflects the remote as of the last sync, not the last task.
4. Status (`GET /projects/:id/checkout`) reports, per branch: commit, remote
   commit, how many commits behind, dirty or not, history depth, last sync time.
5. Full history (no `--depth`): the clone exists to be read, including why code
   looks the way it does. Task clones stay shallow (`GIT_CLONE_DEPTH=1`) because
   they exist to be edited and deleted.

### Credentials

The clone uses the same resolution as a task (ADR-021, ADR-058, ADR-059): the
project's own override, then the connection's credential, then the
organisation's saved credential for the host. Never the host's SSH key. The
resolution was extracted from `TaskRepository` into
`agent/git/project-git-access.ts` so tasks and checkouts cannot drift apart.

### Safety

- Branch names become directory names only through `escapeSegment`, which
  replaces every character outside `[A-Za-z0-9._-]` and refuses `.`/`..`, so a
  ref from a repository can never introduce a path separator.
- A branch must be one the project knows (default branch or an environment's
  branch); arbitrary refs are refused before anything is created on disk.
- Only code is cloned. No database, no filestore, no customer data (ADR-019
  stays the boundary for running client code).
- Each sync is audited (`PROJECT_CHECKOUT_SYNCED`).

### Disabled

Leaving `PROJECT_CHECKOUT_ROOT` empty disables the feature; the panel says so.
`PROJECT_CHECKOUT_REUSE` is reserved for letting task workspaces seed from the
local clone and is off: task clones stay independent of it until that is proven.

## Consequences

- The project page can answer "is this host's copy current?" at any time,
  without running a task.
- A second copy of the code exists on disk and can be stale between syncs.
  That is shown, not hidden: the panel states the commits behind and the time of
  the last sync, and syncing is one click.
- Disk use grows by one full clone per project branch synced.
- Syncing is on request, not scheduled; a webhook or timer can call the same
  service later without changing its contract.
