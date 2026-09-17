# ADR-052: Ephemeral preview instances — see the draft Odoo UI before approving

- Status: Proposed
- Date: 17 September 2026
- Milestone: Phase 5 (review), target a later phase

Builds on ADR-021 (the approval gate), ADR-027 (running Odoo for validation),
ADR-039 (root-run provisioning scripts), ADR-045/051 (template databases),
ADR-049 (a root-gated script for a new privileged shape) and ADR-050 (repo-backed
connected projects).

## Context

Review is code-only today. A person sees a `DiffViewer` patch with line numbers and
an `ApprovalPanel` naming what is being authorised. They do not see what the change
looks like in Odoo — a reordered field, a broken form, a view that raises on open —
until it is on a running instance. The operator asked for a preview with a real UI
presentation, so the decision to approve rests on the draft itself rather than on a
reading of the patch.

Two things make this feasible now that did not exist when the platform started:

- ADR-045/051 provide a **data-safe database**: a standard template per version,
  edition and region, cloned in seconds, with no client data.
- ADR-050 provides **the draft's code as a clone**, so a task's change can be run
  somewhere other than the customer's host.

One constraint decides the shape of the whole feature, and it is easy to miss:

> **The task workspace is destroyed the moment a run suspends for an approval.**
> `AgentWorkflow.run` releases it in its `finally` block whether the task settled,
> suspended at an approval, or yielded (`agent-workflow.ts:145-151`,
> `releaseWorkspace`). Holding a clone of customer source open across a human wait
> of unknown length is deliberately worse than re-cloning.

So at the moment a person is looking at the approval — exactly when a preview would
be wanted — there is **no workspace and no working tree**. What survives is the
task's retained diff: `agent_tasks.diff_patch`, written by
`TaskRepository.saveDiffPatch` and capped at 256 KiB by default, plus
`modified_files` and `diff_stats`.

A second constraint: `CommandRunner` is the platform's only process chokepoint and
it always applies a timeout and kills the child. A persistent Odoo HTTP server cannot
be owned by it. A long-lived process must be a root-run script / systemd unit, in the
shape ADR-039 and ADR-049 already established.

## Decision

### 1. The preview is an explicit action, not an automatic one

A person requests a preview for a task that has a draft diff. It is not started on
every task: it costs a database and a running Odoo, and most tasks do not need it.
The action is offered where the draft exists — before the `git_push` approval (or the
`chat_edit` write, once such a write can land) — and the approval gate is unchanged:
the preview informs the decision, it does not replace it.

### 2. The preview is reconstructed from the retained draft, not a live workspace

Because the workspace is gone, the preview is built from durable artefacts:

1. **Code** — clone the task's target branch at the task's base commit, then apply
   the task's retained `diff_patch`. This reproduces the draft without a retained
   workspace and without a push.
2. **Database** — clone the standard database for the project's version, edition and
   region (ADR-051); a scratch database named for the preview, never a client
   database.
3. **Odoo source** — the shared, read-only checkout for the project's version
   (ADR-045).

If `diff_patch` was truncated (`patchTruncated`) or is absent, the preview is
**refused with that reason** rather than shown incomplete.

### 3. The preview runs behind a root script, as the other privileged steps do

`infrastructure/provisioning/preview-project.sh` gains `start` and `stop`
subcommands and is added to the `Cmnd_Alias LINKEDERP_PROVISION`, behind the
provisioning switch. `assertProvisioningInvocation` gains a matching disjoint branch:

```
preview-project <project-name> <preview-ref> <branch>     (patch on stdin)
preview-project stop <project-name> <preview-ref>
```

The patch travels on **stdin**, as ADR-049's pull credential does, so a draft never
appears in `/proc/<pid>/cmdline`. `start` creates the scratch database, applies the
patch to a fresh clone, updates the changed modules and starts a systemd unit on an
allocated port; `stop` stops the unit, drops the database and removes the clone.

### 4. Modules come from the draft's changed paths

The module roots in the patch's changed paths are the modules to update (`-u`), the
same derivation the validation step already uses from `git diff`. A module that
fails to install is reported as the preview's own result — a draft that does not
install is exactly what a reviewer needs to know — not as a platform failure.

### 5. The preview is short-lived, singular and reclaimed

- **One preview per project at a time.** A second request stops the first.
- **A TTL** (for example 30 minutes) after which it is destroyed; the portal shows
  the remaining time.
- **A reaper** for orphans, modelled on the workspace reclaimer: a preview whose
  owning worker dies is found and destroyed on the next startup.
- Destroy means: stop the unit, drop `preview_<ref>`, remove the clone.

### 6. The preview is a network surface and is treated as one

It serves **client code**, so it is bound the way validation is: a scratch database,
a dedicated database role, no customer credential, and the process chokepoint. Being
reachable, it additionally requires:

- an **authenticated, short-lived link** (a signed token or equivalent), not a public
  URL;
- a domain that cannot be confused with the customer's own (a `preview-` label);
- `noindex`, and refusal when the preview is not ready.

### 7. Data is baseline, and that is stated on screen

The preview database is the standard baseline, not client data. The portal says so
plainly, because a change that depends on a customer's records will look different
here, and a reviewer who is not told will read that as a bug in the draft.

### 8. Modes

Preview is available where the platform holds the draft's code: `odoo_sh`,
`repository`, and `on_premise` with a repository (ADR-050). It is **not** available
for `odoo_online`, which has no filesystem.

## Consequences

- A reviewer sees the draft's real UI before approving, which is the whole point.
- Resource cost: an active preview is one Odoo process and one database. The
  one-per-project bound and the TTL are what keep that bounded, and a small host may
  still only support a few at a time.
- The platform gains a new privileged shape (`preview-project`), which is a real
  widening of the root grant and must be validated as narrowly as the others.
- The 256 KiB patch cap becomes a functional limit: a very large draft cannot be
  previewed. Either the cap is raised for review, or the preview says it cannot
  reconstruct the draft.
- Approval semantics do not change. "Approve" still authorises the commit/push (or
  the write); the preview only makes that decision better informed.
- A draft that installs but crashes at render is shown crashing — which is the honest
  and useful outcome.

## Alternatives considered

- **Static rendering of changed views** (parse XML, draw a mock). Cheap, and it
  cannot show behaviour, a compute field, or a server error — the things most worth
  previewing. Rejected as the primary mechanism.
- **Deploy to staging and preview the staging URL.** This is a deploy, which is what
  the approval gate exists to precede. It inverts the order the operator asked for.
- **Screenshot via a headless browser.** Asynchronous, brittle, not interactive, and
  it still needs the instance the other options build. A later enhancement at most.
- **Retain the workspace while an approval is pending.** Rejected: it puts a clone of
  customer source on disk for an unbounded human wait, against the posture
  `releaseWorkspace` exists to keep. The retained patch is the durable artefact
  instead.
- **An always-on dev instance per project.** No lifecycle problem, but a permanent
  database and process per project, and it drifts from the branch without a defined
  refresh. Rejected in favour of ephemeral.

## Retirement condition

Retire or revise if a durable, low-cost rendering mechanism makes a live instance
unnecessary, or if workspaces become durable across approvals for another reason — in
which case the patch-reconstruction step is the piece to revisit.

## Verification

Not implemented. When it is, the checks are:

- Requesting a preview on a task with a draft produces a running instance whose
  `addons_path` includes the reconstructed draft; a request on a task with no or a
  truncated diff is refused with that reason.
- The preview database is the standard artifact for the project's version, edition
  and region, and its `database.uuid` is fresh.
- `stop`, the TTL and the reaper each leave no unit, no database and no clone behind.
- The preview URL refuses an unauthenticated request and is not reachable after the
  TTL.
- A `odoo_online` project is not offered a preview.
- The `preview-project` branch of `assertProvisioningInvocation` is tested by
  refusal: a malformed project name, preview ref or branch, an extra argument, and a
  missing patch.
