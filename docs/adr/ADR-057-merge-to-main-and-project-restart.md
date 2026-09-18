# ADR-057: Merge staging into main, and restart the running instance

- Status: Accepted
- Date: 18 September 2026
- Milestone: Phase 5 (connected-server estate)

Builds on ADR-021 (push safety and target environments), ADR-039 (provisioned Odoo
instance), ADR-046 (a task works on the branch a person chose), ADR-049 (an instance
pulls its own repository), ADR-054 (per-client backups) and ADR-056 (module selection
at project creation).

## Context

A task commits and pushes onto the environment's own branch (ADR-046) — `staging` for
a staging environment. ADR-049 closed the read side of that: a provisioned instance can
be told to pull whatever `defaultBranch` its project row names, and `pull-project.sh`
resets the instance's `addons/` checkout to that branch's tip.

Two things a person actually does after promting on `staging` are still missing, and
both were asked for directly:

> *"kan saya sudah promting di staging. gimana caranya biar pada project yang kita
> promting codenya masuk ke projectnya? berarti kita butuh fungsi untuk merge ke main,
> dan melakukan restart server project odoonya"*

**First: there is no way to get `staging` onto `main`.** `pull-project.sh` pulls
whatever branch a project's row names — it does not choose one, and it does not
combine two. `main` is the branch ADR-021/028 keep a task from ever writing to
directly, precisely because it is meant to be the reviewed, promoted state; nothing
today promotes `staging` onto it. Today that merge is a manual `git merge` a person
runs on their own machine, outside the platform's audit trail.

**Second: pulling new code is not enough to serve it.** `pull-project.sh` resets
`addons/` on disk, but does two things not at all: it does not run `-u <module>` to
apply a new or changed field, view or migration to the instance's database, and it
does not restart the systemd unit to load the new Python. A field like the
`purchase_delivery_status` module's `x_delivery_status` — a new column, a new compute
method — is invisible until both happen. `--stop-after-init` in isolation is not
enough either: it exits without leaving the always-on `Restart=always` unit serving
anything, and a bare `systemctl restart` without a preceding `-u` reloads the old
schema with the new Python, which is its own class of broken.

Deploying "for real" today is: SSH in as root, `git -C addons pull` by hand
(bypassing `pull-project.sh`'s ownership fix-up), run `odoo-bin -u <something>`
by hand, guess which modules changed, then `systemctl restart odoo-<project>` by
hand. Every step is exactly the kind of narrow, whitelisted, audited action the
existing provisioning scripts exist to replace.

## Decision

### 1. Merge is a platform-run git operation, not a root script

Unlike `pull-project.sh`, this does not touch `/opt/odoo/projects/` at all — it
operates on the project's **bare-equivalent view of the GitHub repository** the same
way `GitHubRepositoryService.pushBranches` already does: clone-less, over HTTPS, using
the project's own stored git credential (the `project_connections` row ADR-041
records), through `GitService`. No new sudoers entry, no new script.

`POST /api/v1/projects/:projectId/merge-to-main`:

1. Requires admin project access (`requireProjectAccess(..., { requireAdmin: true })`
   — the same bar `pull` sits behind, because this changes what `main` is).
2. Requires the project to have a `repositoryUrl` and a `staging` environment (its
   `branch` is the source; `main` is always the target — never configurable, so this
   route can never be pointed at an arbitrary branch pair).
3. Shallow-clones the repository into a throwaway `/tmp` workspace at `main`'s tip
   (depth 1, single-branch — the same shape `GitService.clone` already does for a
   task workspace), fetches `staging`, then runs:

   ```
   git merge --no-ff -X theirs origin/staging -m "Merge staging into main (LinkedERP)"
   ```

   `-X theirs`: the operator's explicit answer to "what happens on conflict" — this
   route always produces a commit, never stops halfway asking a human to resolve
   conflicts by hand, because there is no human in this loop to ask. `staging` is
   the branch a task actually writes to and the one a person just reviewed by asking
   for this merge; on any hunk both sides touched, `staging`'s content wins. This is
   a one-way promotion, not a three-way collaboration, and `--no-ff` keeps the merge
   visible as its own commit in `main`'s history rather than silently rewriting it to
   match `staging`.
4. Pushes the resulting commit to `main` with `GitService.push` — the one push in the
   platform that is allowed to target `main`, because it is not a task push (ADR-021
   §2 refuses only the *task* path onto `main`) and it is not silent: it is its own
   audited, admin-gated action a person asked for by name.
5. Deletes the throwaway workspace whether it succeeded or not.

Refused outright, before any clone, when: the project has no repository; the project
has no `staging` environment; `GIT_PUSH_ENABLED` is false (the same process-layer gate
every other push already sits behind — merge is a push and gets no exception).

The response carries the resulting commit on `main` and the record of what was
merged, and an audit event (`PROJECT_MERGED_TO_MAIN`) is written either way, the same
pattern `ProjectDeploymentService.pull`/`refuse` already establishes.

### 2. Restart is `pull` + upgrade + `systemctl restart`, queued like a selective install

Unlike merge, this *does* need root: applying a module upgrade runs Odoo against the
instance's own database, and reloading the unit is `systemctl`, neither of which the
`cartenz` user may do. A ninth script joins `LINKEDERP_PROVISION`:

`infrastructure/provisioning/restart-project.sh <project_name> <repository_url> <branch>`

Same three-argument shape as `pull-project.sh` (so `assertProvisioningInvocation`'s
existing `isPull`-style branch is copied, not reinvented, with its own configured path
so the two remain distinguishable only by which path was configured, exactly as
`isBackup`/`isModulesList` already are indistinguishable from `isGrant` by shape
alone). It does, as one root-run unit that either finishes clean or leaves the instance
in its state from before the attempt:

1. **Record the current commit**, then run the pull by **invoking
   `pull-project.sh` as a subprocess** (`echo "$CREDENTIAL" | pull-project.sh
   <project> <url> <branch>`) rather than duplicating or refactoring its body.
   That script is production-critical and already tested on real projects; the way
   to reuse it is to call it, not to split it into a shared library and change the
   thing that works. Its own validation, its stdin-credential handling and its
   ownership fix-up (the setgid re-establishment) all apply unchanged. The old
   commit is captured *before* this, from `git -C addons rev-parse HEAD`.
2. **Stop the unit**: `systemctl stop odoo-<project>`. Before the upgrade, not
   after — a running Odoo holds open connections and row locks on the very tables
   the upgrade alters, and an `-u all` racing the live service is how an upgrade
   deadlocks or half-applies.
3. `sudo -u odoo <python> <odoo-bin> -c <project>/config/odoo.conf -d <db> -u all
   --stop-after-init --no-http`, logged to the private-tmp path the selective install
   already logs to (`/tmp/cartenz-restart-<project>.log`, read back the same way a
   selective-install failure is diagnosed today: `/proc/<worker-pid>/root/tmp/`
   because `PrivateTmp=yes`). `-u all`, the operator's explicit choice: simpler and
   certain to pick up every changed module, at the cost of a slower upgrade than
   naming just the changed ones — acceptable because this is an explicit, occasional
   action, not something run on every commit.
4. On success: `systemctl start odoo-<project>`, then a short poll of
   `systemctl is-active` (mirroring `create_project`'s own post-start check) before
   the script reports success — a start that leaves the unit crash-looping is a
   failure the caller needs to see, not a green checkmark.

**On failure of step 3, roll the code back and report it.** The instance is already
stopped and the new code is already on disk, so "leaving it as it was" is not a
state that exists by itself — it has to be reassembled, or the operator is left with
a down instance and a half-migrated database and no idea which. So: `git -C addons
reset --hard <the commit recorded in step 1>`, `systemctl start odoo-<project>`,
and report failure, naming the log path. The instance comes back on the code it was
serving before, and the message says the upgrade failed and the code was rolled
back. Downtime spans steps 2–4 and is real; the portal says so before the button is
pressed.

### 3. Restart runs on the provisioning queue, not inline

`-u all` against an instance with many modules can run past `PROCESS_MAX_TIMEOUT_MS`
(5 minutes) the same way a selective install can (ADR-056 §Task 9's reason for going
async in the first place). `POST /:projectId/restart` enqueues a
`ProjectRestartJobData` job on the existing `PROJECT_PROVISIONING_QUEUE` (a new job
name, `restart-project`, on the queue ADR-056 already created — not a second queue)
and returns immediately with a job reference; the worker calls
`ProjectDeploymentService.restart` (the `sudo -n restart-project.sh ...` invocation)
and writes the outcome onto the project row, the same polling shape the portal already
uses for provisioning status.

### 4. The portal sequences merge, then restart, as one "Ship to production" action

The two routes are independent and separately callable, but the common case is "get
what I just promted on staging actually live": the portal's action calls
`merge-to-main`, and on success calls `restart` with `branch: 'main'` — restart's
branch argument is not implicitly `defaultBranch`; the caller states it, because a
restart against `staging` (re-syncing a preview/staging instance with the latest
staging commit) is exactly as legitimate a call as a restart against `main`, and this
route must not assume which one a person means.

## Consequences

- A person can go from "promted on staging" to "live on the instance serving `main`"
  without an SSH session, in two platform actions instead of four manual ones.
- `main` still receives no automatic, unreviewed writes: the merge is always a named
  action an admin took, never a side effect of a task finishing.
- `-X theirs` means a hand-edit made directly on `main` (there should be none, but
  nothing stops one today) is silently discarded by the next merge. Documented here
  as the accepted behaviour, not a bug: `main` is a promotion target, not a place to
  edit.
- The new root privilege (`restart-project.sh`) is scoped exactly like its seven
  predecessors: one script, one argument shape, both gates. It is a strictly larger
  privilege than `pull-project.sh` alone (it now also runs Odoo against the instance's
  database and controls its systemd unit), which is why it is its own script and not
  an extra mode bolted onto `pull-project.sh`.
- A restart is slow (an `-u all` upgrade, potentially minutes) and queued exactly
  like a selective install already is; the portal shows the same kind of
  provisioning-status polling it already has, not a spinner blocking the request.
- No backup is taken before a restart's `-u all` by this ADR alone. ADR-054's backup
  already runs before a push onto `staging`; restart operates on `main`, which nothing
  backs up today. Left as a follow-up rather than folded in here, since the operator's
  stated preference (ADR-054's own history) is backups off unless asked for again.
