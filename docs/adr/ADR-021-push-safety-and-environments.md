# ADR-021 — Push safety, target environments, and SSH remotes

**Status:** Accepted · **Date:** 28 August 2026 · **Milestone:** Pre-Phase 5 safety work

## Context

The platform is about to be connected to a real Odoo.sh project. Three things that were
acceptable against a fixture are not acceptable against a customer's repository.

**First, the reason push does not happen is too weak.** `git_push` is written as a simulation and is
marked `availableToModel: false`, and the `git_push` approval gate stands in front of it. That is
four layers, and it is still the wrong kind of guarantee: it rests on how one tool happens to be
implemented. Someone implementing Phase 5 removes the simulation and the protection goes with it.
The customer's question — "what stops you pushing to my repository?" — deserves an answer that is a
property of the system rather than of a to-do list.

**Second, there is no notion of which environment a task targets.** In Odoo.sh an environment *is* a
branch: `production`, one or more staging branches, and development branches. The platform stores a
single `default_branch` and nothing marks it as production. Nothing prevents a project being created
with `default_branch: production`, and nothing would stop a task branching from it. On Odoo.sh that
branch is the live business.

**Third, the platform accepts SSH remote URLs it cannot actually use.** `assertSafeRemoteUrl` accepts
the `ssh` scheme, and `GitService` has no SSH key provisioning at all — no `GIT_SSH_COMMAND`, no
identity file, no host key handling. Odoo.sh's native remote is
`<project>@git.odoo.com:<project>.git`, which is SSH. So the most common way to reach an Odoo.sh
project is a URL the platform accepts and then fails on, which is worse than refusing it.

## Decision

### 1. Push is refused at the process chokepoint, not by the tool

`GIT_PUSH_ENABLED` defaults to **false**. When false, `CommandRunner` refuses any `git` invocation
whose subcommand is `push`, before the process is started.

This is deliberately the same mechanism that refuses `sh`, `bash`, `curl` and `rm`: a
`CommandNotPermittedError` raised by the one class in the platform that can start a process. It does
not matter which code path asked, whether a tool was marked simulated, whether a permission was
granted, or whether an approval was recorded. There is no `git push` for the process layer to run.

Two consequences are intended:

- Phase 5 cannot be delivered by deleting a simulation. It requires setting `GIT_PUSH_ENABLED=true`
  deliberately, which is a configuration change an operator makes and an auditor can see.
- The guarantee is testable as an absolute. `command-runner.spec.ts` asserts that `git push` is
  refused, and asserts it at the same level as the shell-injection cases.

The subcommand is found by scanning the argument vector past the `-c key=value` configuration pairs
that every invocation carries, so `git -c core.hooksPath=/dev/null push` is refused as readily as
`git push`.

### 2. A task targets a named environment, and production is refused

`project_environments` records the environments a project has: a name, a branch, and a `kind` of
`production`, `staging` or `development`. One is marked the default target.

Task creation resolves a target environment and **refuses outright when its kind is
`production`**. Not "requires approval" — refused. The MVP has no production deployment path
(chapter 17 puts it out of scope), so an approval gate in front of production would be a gate in
front of a capability that does not exist, which is worse than a closed door.

Environments are declared at project creation, because that is when the person creating the project
knows which branch is which. A project created without them gets one `development` environment
derived from `default_branch`, so nothing breaks and nothing is silently treated as production.

The branch a task clones from is the target environment's branch, not `default_branch`. The two are
kept separate because `default_branch` is a repository fact and the target is a choice.

### 3. SSH remotes are supported, with the host key question answered explicitly

`GitService` provisions an SSH key for the clone through `GIT_SSH_COMMAND`, on the same lease
pattern as the HTTPS askpass helper: the key is written into the workspace metadata directory at mode
0600, outside the clone where the agent's file tools cannot reach it, and removed in a `finally`
block.

Host key verification is the part worth stating plainly, because the convenient answer is wrong.
`StrictHostKeyChecking=no` accepts any host key and makes the connection trivially
man-in-the-middleable. The platform therefore:

- writes its own `UserKnownHostsFile` per operation and sets `IdentitiesOnly=yes`, so no key or host
  entry from the host machine's own SSH configuration is consulted;
- uses `StrictHostKeyChecking=yes` when the connection has a recorded host key, which is the correct
  posture and is what a configured project should reach;
- uses `accept-new` when it does not, records the fingerprint it learned on the connection, and logs
  a warning naming the residual risk.

`accept-new` is a real compromise and is described as one: it trusts the first connection. It is what
most CI does, and the recorded fingerprint means a later change is detected even though the first
contact is not verified. An operator who wants the strict posture supplies the host key on the
connection.

`connection_type` gains `odoo_sh`, and connections gain a `credential_kind` of `token` or `ssh_key`
so that the credential's type is a fact about the record rather than something inferred from the
remote URL.

## Consequences

The answer to "what stops you pushing to my repository" becomes a refusal at the process layer with
a test beside it, rather than an assurance about an unfinished feature. The answer to "how do I
choose staging" becomes a field at project creation, with production refused rather than merely
discouraged. And an Odoo.sh project reachable only over SSH becomes reachable.

The costs: three new configuration values, a table, and a migration. `accept-new` leaves a
first-contact trust assumption that a strict deployment must close by supplying host keys. And a
project whose only branch is called `production` cannot be worked on at all until an environment is
declared for it — which is the intended behaviour, not an oversight.

## Retirement condition

Section 1 is not retired; `GIT_PUSH_ENABLED` becomes true in deployments that have accepted Phase 5,
and the chokepoint refusal remains for those that have not. Section 2 stays. Section 3's `accept-new`
fallback should be removed once host keys are provisioned as part of connection setup.

## What was built and how it was verified

Recorded here because the value of this ADR is entirely in whether the guarantees hold, and an
unverified guarantee is worse than none: it is an assurance someone will rely on.

**Section 1, the push refusal.**

- `CommandRunner.run` refuses a guarded git subcommand before argument validation and before any
  process is built. The subcommand is found by `findGitSubcommand`, which walks past git's own
  options and their values, so `git -c core.hooksPath=/dev/null push` and `git --git-dir X push`
  are both refused.
- `infrastructure/scripts/probe-push-refusal.js` loads the **compiled** runner from `backend/dist`
  and asks it to push in seven forms, with `git --version` as the control. Eight checks, all
  passing. This is deliberately a probe of the artefact rather than of the source: the unit tests
  prove the source refuses, and a customer is entitled to evidence about what is running.
- With pushing disabled the workflow no longer requests push approval. It completes and says so.
  An approval that cannot lead to the act it names teaches people that approvals are decoration,
  so `committing -> completed` was added to the state machine for this case.
- `GET /agent/capabilities` reports `git.pushEnabled`, `git.pushReason` and `git.sshHostKeyPolicy`.
  The portal reads the posture from the server rather than restating the documentation.

**Section 2, the production refusal.**

- Refused in `ProjectEnvironmentsService.resolveTarget` before the task row or session row is
  written, so a task targeting production leaves no trace beyond the refusal itself.
- Refused equally when moving the default target, so production cannot become the default by a
  second route.
- Both refusals write `environment.target_refused` to the audit trail, naming the branch and the
  person. A refusal nobody can see is indistinguishable from a request nobody made.
- The environment's branch is what gets cloned. The smoke test asserts the task's `base_commit`
  equals the tip of the environment's branch in the remote, because a task that silently used the
  project default would read and change production code while reporting development.

**Section 3, SSH host keys.** Covered by unit tests (35) over the credential lease: file modes,
`IdentitiesOnly`, its own `known_hosts`, `StrictHostKeyChecking` never `no`, strict when a host key
is recorded, and cleanup on release. **Not yet verified against a real SSH remote** — no such remote
has been connected.

**Test counts.** 267 backend unit tests; smoke tests 54 (full), 38 (repository), 31 (agent),
21 and 20 (safety, run with pushing disabled and enabled respectively); 15 portal-surface checks.
All passing. The safety and full suites were run in both push configurations, because a guarantee
tested in one configuration says nothing about the other.

## Amendment, 2026-08-28 — declaring environments on an existing project

Two gaps found while setting up a real project that predated this ADR.

**A project created before environments existed had none, and no way to get any.** §2 declares
environments at creation. Nothing back-filled the existing rows, and the portal offered no way to
add one — so the project listed nothing, every task was refused, and there was no route out.
`POST /projects/{id}/environments` existed but was not surfaced; it now is, on the project's
settings page.

It is still not back-filled automatically, and that is deliberate. Guessing that a project's default
branch is a development branch is precisely the mistake §2 exists to prevent: on this repository the
default branch is `main`, which is production.

**The repair path had the safety inverted.** `add` reused the whole-set validation from creation, so:

| Declaring `main` as… | Before | After |
| --- | --- | --- |
| `production` — the protective declaration | **Refused**: "every environment declared is production" | Accepted |
| `development` — which lets the agent work on production | **Accepted** | Accepted |

The refusal was true of the one-item set and irrelevant to the project. The safe declaration was
blocked while the dangerous one went through, and every existing test passed.

Validation is now split: `assertValidOne` checks an environment's own name, kind and branch;
`assertValid` keeps the rules that are properties of a whole project — uniqueness, and that
something is targetable — and applies only at creation. A project with only production declared is
allowed to exist; the refusal moves to task time, where the message says what to add.

Verified by 5 unit tests naming the inversion and 6 checks in `smoke-test-safety.sh` §1b, which walk
the repair in the order a careful person would: declare production first, be told a targetable
environment is needed, declare it, and confirm the task runs on that branch and not on `main`.
