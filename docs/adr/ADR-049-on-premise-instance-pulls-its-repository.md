# ADR-049 — An instance pulls its own repository

**Status:** Accepted
**Date:** 2026-09-16

## Context

ADR-041 gives a created project a GitHub repository and makes the platform able to reach it.
Every part of that is a *push*: the agent commits in a task workspace, the platform pushes the
branch, and the repository records it.

The instance never hears about it.

`create_project` lays down a scaffold, and ADR-041's backfill makes `addons/` a git checkout with
an `origin` — verified on this host, all three provisioned projects have one:

```
ggroma     -> https://github.com/BintangLinked/ggroma.git
omg        -> https://github.com/BintangLinked/omg.git
tokorotiku -> https://github.com/BintangLinked/tokorotiku.git
```

But there is no `git pull`, `git fetch` or `git clone` anywhere in `create_project`,
`create_project_enterprise`, or `infrastructure/provisioning/host/*`. The relationship is
one-way. A commit pushed to the project's branch — by a developer, by an earlier task, by
anyone — does not reach the running Odoo, and the instance quietly serves whatever the
directory happened to contain on the day it was provisioned.

That is the difference between this platform and odoo.sh, and it is a difference in kind
rather than in polish: in odoo.sh the server is a *deployment target* for a branch, and the
branch is the truth. Here the server was the truth and the branch was an artefact.

## Decision

### 1. A root-run script does the pull, and only the pull

`infrastructure/provisioning/pull-project.sh` is added to the existing
`Cmnd_Alias LINKEDERP_PROVISION` in `infrastructure/provisioning/99-linkederp-provisioning` —
the same file, not a second sudoers file, following the shape ADR-040 established:

```
pull-project <project_name> <repository_url> <branch>
```

`assertProvisioningInvocation` gains a matching disjoint branch: a fifth configured script
path, `https://` or scp-style URL, a branch that cannot begin with a hyphen, exactly five
arguments. The sudoers rule and that check remain two independent gates, neither trusted
alone.

The work cannot be done from this process. `/opt/odoo/projects/<name>/` is `odoo:odoo` mode
750, and the `cartenz` user the platform runs as has no write access to it — which is exactly
why provisioning already goes through this bridge.

### 2. The pull runs as `odoo`, and resets to the branch tip

`addons/` is `odoo:odoo` because Odoo reads it. A root-run `git` would leave root-owned
`.git` objects, breaking both the running service and the platform's own commits into the same
directory (ADR-032). The script calls `sudo -u odoo`, and re-establishes ownership and the
setgid bit that `grant-addons-write.sh` set, because a `chown -R` does not.

`reset --hard` is deliberate. This directory is a deployment target, not a working copy: task
workspaces live in `/tmp` and push from there, so a local edit here is either a leftover or an
accident, and the branch is the truth. Anything that is only on the server is replaced, and
the portal says so before the button is pressed.

### 3. The credential travels on stdin

`CommandRunner` already supports passing data to a child's stdin. A token in `argv` is
readable by every user on the host through `/proc/<pid>/cmdline` for as long as the fetch
lasts, so the platform writes it to the script's stdin and the script hands it to git through
a mode-0700 `GIT_ASKPASS` helper that only the `odoo` user can read. The connection is chosen
the way the task layer chooses it — the oldest of `GIT_CONNECTION_TYPES` with a secret — so an
Odoo API key is never presented to a Git host. A public repository has no credential, which is
not an error.

### 4. It is an action a person takes, and it is recorded

`POST /projects/:projectId/pull`, admin-gated, returning the resulting commit. Audited as
`project.pulled` / `project.pull_failed` — separately, because a failed deploy leaves the
instance on its previous commit and a person who pressed Deploy is entitled to know that what
is running is not what is on the branch.

A refusal is returned as a normal result rather than thrown: "this project has no repository"
and "the branch does not exist" are answers to the question asked, and the script's own last
line names the cause better than a status code can.

### 5. Empty is the off switch, and it is checked twice

`PROJECT_PULL_SCRIPT` unset means the deployment has not installed the script or its sudoers
entry. `CommandRunner` then refuses the invocation, and the portal does not offer the action.
That is the same shape as ADR-040's HTTPS toggle, and for the same reason: a Deploy button
whose every press is refused by the other gate reads like a bug in the platform.

## Consequences

- The instance directory becomes a deployment target. That is the point, and it is also the
  thing to know before enabling it on a host where an operator has been editing
  `/opt/odoo/projects/<name>/addons` by hand.
- A pull that fails changes nothing: the script fetches before it resets, so a bad branch or an
  unreachable remote leaves the checkout where it was.
- Nothing is automatic yet. There is no webhook and no scheduled pull.

## What this decides about the `on_premise` project type

The `on_premise` type now takes a repository, which is what makes the above reachable for it.
An on-premise project is a directory on this host, and the platform deploys *that directory's
repository* into it — supplying the URL, the branch and the credential at creation, the way
odoo.sh asks for them.

The field stays **optional**, and the type deliberately stays out of
`REPOSITORY_BACKED_PROJECT_TYPES`. ADR-026's case is real and different: the platform installed
beside a customer's Odoo, reading a working copy that may be a checkout of nothing. Requiring a
repository would delete that capability to add this one. With a repository recorded, branch
probing reads the remote — the list Deploy can actually fetch — and without one it still reads
the local checkout's own branches, as before.

`ON_PREMISE_ROOT` and the projects root are the same directory here
(`/opt/odoo/projects`), so the directory the picker offers is the directory
`pull-project.sh` resolves from the project's technical name. That is a property of this
deployment's configuration rather than a guarantee: a host where the two differ would pull
into the projects root and the on-premise path would point elsewhere.

Still not decided: letting the platform **create** the instance directory for an on-premise
project, so a person can supply a repository and nothing else. Today they still pick a
directory that exists, or take the Create-with-AI flow, which scaffolds and provisions.

## Alternatives considered

- **Pull in the task workspace as `cartenz`.** Refused by the filesystem: the project directory
  is `odoo:odoo` 750 with an execute-only bit for others, so `cartenz` can neither write nor
  list it. A copy would have to be moved into place afterwards, which needs root anyway.
- **Add a `git pull` to `create_project`.** `create_project` refuses to run against a directory
  that already exists, and it is not re-run for a live project — so this would only ever cover
  the first moment, which is the one moment a pull is not needed.
- **A GitHub webhook.** It is the odoo.sh-shaped answer and it is not free: a publicly
  reachable endpoint, a shared secret, and a delivery guarantee this platform does not have.
  The manual action produces the same result for an operator who wants it now, and can be
  layered on top of the same script later without changing anything below it.

## Verification

| What | Result |
| --- | --- |
| 13 new guard tests: valid https/scp pulls, branch separators, `--upload-pack` as a branch, `file://`, `git://`, shell metacharacters, invalid names, trailing arguments, missing branch, and the unconfigured-script refusal | PASS |
| The whole `command-runner` suite, so the new branch is shown not to have widened the create, grant or HTTPS shapes | PASS — 67/67 |
| 11 tests on the directory a pull is pointed at, including both recorded forms of the on-premise path and every path that escapes the projects root | PASS — 11/11 |
| The script refuses to run as a non-root user, and validates its arguments before touching anything | PASS (live) |
| `bash -n` on the script | PASS |
| `tsc --noEmit` over the backend | PASS — exit 0, no diagnostics |
| `tsc --noEmit` over the frontend | PASS — exit 0 |
| **The pull has not been run on this host** | NOT VERIFIED — it needs the sudoers entry installed (a root step) and a project whose repository the platform is permitted to read |

That last row is the honest state of this: the mechanism is written, gated, and tested at the
boundary, and the first real pull is an operator step away.

**What the tests caught.** The first version of the directory resolution took the parent
basename of the recorded on-premise path. That is correct for the provisioned form
(`…/ggroma/addons`) and wrong for the scaffolded one (`…/ggroma`, which yields `projects`), and
it read `/opt/odoo/projects/../etc/addons` as `etc`. The value it produces is the argument to a
script that runs `git` as root in that directory, so a plausible-but-wrong answer there is not a
local mistake. It is now anchored to the configured projects root, accepting exactly one path
segment below it, and the cases above are tests rather than reasoning.
