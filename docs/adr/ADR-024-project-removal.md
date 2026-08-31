# ADR-024 — Project removal

**Status:** Accepted
**Date:** 2026-08-28

## Context

`DELETE /projects/{id}` existed and archived the project. There was no way to undo that, no way to
delete anything permanently, and no button for either — so a portal accumulated test projects with
no way to clear them.

Two problems were found while building the way out.

**Archiving was a trapdoor.** `requireProjectAccess` filtered archived projects out
unconditionally. Correct for the paths that do work — a task must not run against a project someone
has put away — but it also meant an archived project could not be read, restored or deleted. It
vanished from the list and became unreachable.

**A plain delete would have orphaned credentials.** Every child table cascades from `projects`, so
the row and its tasks, sessions, environments and connections would go. But
`secret_records.project_id` carries no foreign key, deliberately (ADR-014): a secret's lifetime is
not governed by the row that points at it. The consequence is that deleting a project would leave a
customer's repository credential encrypted in the database forever, owned by nothing and referenced
by nothing.

## Decision

### 1. Two operations, named for what they do

**Archive** (`DELETE /projects/{id}`) is reversible and is what most people mean. The project leaves
the list and stops accepting work; nothing is destroyed. The response now says
`archived: true` with a sentence explaining that nothing was deleted, so a caller does not have to
infer the behaviour from the verb.

**Restore** (`POST /projects/{id}/restore`) undoes it.

**Delete permanently** (`DELETE /projects/{id}/permanent`) removes the project and everything it
owns. Its own path rather than a flag on `DELETE`, so that a client meaning to archive cannot delete
by sending one extra field.

### 2. Archived means "cannot be worked on", not "cannot be found"

`requireProjectAccess` takes `includeArchived`. The default is unchanged, so task submission,
connections, environments and permission changes still treat an archived project as absent. Reading,
restoring and deleting pass the flag.

The split is asserted directly, because loosening the filter for three paths could easily have
loosened it for the others: an archived project returns 200 to a read and 404 to a task, a
connection, an environment and a permission change.

### 3. A permanent delete asks for three things

- **Owner role.** Admin is enough to archive; this is not.
- **No unfinished task.** Refused with 409, naming the tasks and their statuses. Refused rather
  than cancelled: a worker mid-run holds a workspace and is about to write rows for a project that
  would no longer exist, and deciding on someone's behalf that their running task should be
  abandoned is not this endpoint's call. `waiting_approval` counts as unfinished — approving it
  afterwards would resume work on a project that had gone.
- **The project's name, typed back.** Trimmed, but case-sensitive. A boolean would be as easy to
  send by accident as on purpose; the point of the field is to make the caller read which project
  they are about to destroy.

Archiving first is *not* required. Requiring it would be ceremony, and the typed name is the real
safeguard.

### 4. Three things are done by hand, because the database will not do them

1. **Sealed secrets are destroyed.** See the context above. This is the reason
   `smoke-test-deletion.sh` exists: a delete that removed the project row and left the credential
   behind would pass any test that only checked the project was gone.
2. **Workspace directories are removed.** The `agent_workspaces` rows cascade; the directories on
   disk do not, because the row is a record of a directory, not the directory itself.
   `WorkspaceManager.discardForProject` carries the same containment guard as `reclaimOrphans` — a
   row pointing outside the configured root is logged and left alone, because removing an arbitrary
   path on the strength of a database value is how a bug becomes data loss.
3. **The audit record is written first.** Afterwards there is no project to describe.
   `audit_logs.project_id` is `ON DELETE SET NULL` precisely so the record of a deletion survives
   the deletion, and the project's name, type, repository URL and task count are copied into the
   metadata so the surviving row still means something.

Secrets are destroyed *before* the row is deleted, so a failure part-way leaves a project that can
be deleted again rather than a secret nothing points at.

### 5. The portal states what a delete does not touch

The repository is not touched. Nothing this platform does can reach it — pushing is refused at the
process layer (ADR-021) — and deleting a project here changes nothing on GitHub or Odoo.sh. Said
in the confirmation and again in the notice afterwards, because "delete project" is exactly the
phrase someone would fear meant otherwise.

## Consequences

Test projects can be cleared out, and a project put away by mistake can be brought back.

The deletion is genuinely irreversible: there is no soft-delete window and no export. That is the
intent — a soft delete that is really a hidden row is what archive is for, and having both pretend
to be the other is how people end up trusting neither.

`countRows`-style generic helpers were considered for reporting what a deletion removed and
dropped: one call site did not justify a function whose types could not be written honestly.

## Verification

`smoke-test-deletion.sh`, 50 checks against a running stack, plus 9 unit tests on the reasoning the
method depends on.

| What | Result |
| --- | --- |
| Archive hides without destroying; the row and `archived_at` are there | PASS |
| An archived project can be read, but refuses tasks, connections, environments and permission changes | PASS (200 / 404 × 4) |
| Restore brings it back, and it accepts tasks again | PASS |
| No confirmation, a wrong name, or the wrong case is a 400 | PASS |
| A refusal names the project, and nothing is deleted by a failed attempt | PASS |
| An unfinished task blocks the delete with 409, naming the task | PASS |
| Cancelling it unblocks the delete | PASS |
| The delete removes the project, tasks, sessions, environments, connections and workspace rows | PASS |
| **Sealed secrets are destroyed, not orphaned** | PASS |
| `project.deleted` survives with `project_id` nulled and the name in its metadata | PASS |
| Another organisation gets 404, and the project survives | PASS |
| Deleting an unarchived project directly works; deleting twice is 404, not 500 | PASS |
| The portal surfaces shipped, including the typed confirmation | PASS (16 checks) |

**Not verified:** the screen was not driven in a browser — the browser pane here cannot reach the
dev server — so this proves the surfaces shipped and the API behaves, not that the buttons feel
right to use.
