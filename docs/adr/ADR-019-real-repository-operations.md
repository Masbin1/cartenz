# ADR-019 — Real repository operations ahead of microVM isolation

**Status:** Accepted · **Date:** 27 August 2026 · **Milestone:** Phase 2 · **Amends:** ADR-013

## Context

Phase 2 of the roadmap is the Repository Agent: repository clone, code search, file read and
modification, Git branch creation and Git diff. ADR-013 recorded that no untrusted code executes
until Firecracker or Kata isolation exists, and that every tool is simulated until then.

Read literally, ADR-013 blocks Phase 2 entirely. That reading is wrong, and the reason matters
enough to record: ADR-013 conflates two different risks that happen to share a workspace.

**Risk A — executing untrusted code.** Running the repository's test suite, its linter, an Odoo
shell or a module upgrade executes code that the AI wrote or that the customer's repository
contains. A kernel boundary is the only adequate control, which is what ADR-06 of the approved
selection record requires.

**Risk B — the platform operating on untrusted data.** Cloning a repository, walking a directory,
reading a file, writing a file, creating a branch and producing a diff execute *platform* code —
git and Node's filesystem API — against untrusted *input*. No customer or AI-authored code runs.

These are not the same risk and they do not need the same control. Risk B is the ordinary problem
of writing a program that handles hostile input, and it is addressed by input validation, path
containment, argument-vector execution, resource limits and least privilege. Risk A is not
addressable that way at all.

Deferring Phase 2 until microVMs exist would therefore buy no security. It would only mean the
agent continues to plan against invented file paths, which is the opposite of the "code-aware"
property the architecture is built around.

## Decision

Repository and Git operations are implemented for real. Validation and execution tools remain
simulated until the isolation boundary exists.

| Capability | Phase 2 | Why |
| --- | --- | --- |
| Clone, fetch | **Real** | Platform runs git against a remote |
| List directory, search code, read file | **Real** | Platform reads its own clone |
| Create, update, delete file | **Real** | Platform writes inside its own workspace |
| Branch, checkout, status, diff | **Real** | Platform runs git in its own clone |
| Commit | **Real** | Local to the workspace, and discarded with it |
| Push | **Simulated** | Leaves the platform boundary; Phase 5 |
| Detect Odoo version, list modules | **Real** | Parses manifest text; does not execute Python |
| Run linter, Python tests, Odoo tests | **Simulated** | Executes repository code — Risk A |
| Odoo shell, module upgrade, service restart | **Not implemented** | Executes repository code — Risk A |

The task record no longer carries a single "simulated" boolean, which could not answer the two
questions a reader actually has. `agent_tasks.simulated_capabilities` names precisely which
categories were simulated, and the portal states them.

## The controls that make Risk B acceptable

These are the substance of the decision, not incidental detail. Each is implemented in one place so
that it cannot be bypassed by adding a tool.

1. **One process-spawning chokepoint.** `CommandRunner` in `backend/src/core/process/` is the only
   code in the platform that starts a child process. It uses `execFile` with an argument vector and
   never a shell string, so no input can be interpreted as shell syntax. It enforces a timeout, an
   output-size cap, an environment allow-list and a working directory that must resolve inside a
   workspace. Commands are drawn from a fixed allow-list of executables.

2. **Path containment on every filesystem operation.** `resolveWorkspacePath` resolves the real
   path — following symlinks — and refuses any result outside the workspace root. Checking the
   requested string for `..` is not sufficient, because a symlink inside the repository can point
   anywhere; the check is made against the resolved target.

3. **Git URL validation.** `assertSafeRemoteUrl` accepts only `https` and `ssh` schemes. It rejects
   `ext::`, which git treats as an arbitrary command; `file://` unless explicitly enabled for
   testing; and any URL whose host or path could be read as a git option.

4. **Git invoked with hostile-repository defaults.** Hooks are disabled
   (`core.hooksPath=/dev/null`), submodules are never recursed, credential helpers are cleared,
   terminal prompting is disabled, and clones are shallow by default.

5. **Credentials never reach an argument vector or `.git/config`.** The token is supplied through a
   `GIT_ASKPASS` helper written with mode 0700 inside the workspace and removed immediately after
   the operation. The remote URL carries the username only. `ps` never shows the token, and the
   clone's stored remote never contains it.

6. **Resource limits.** A workspace has a byte and file-count quota, checked before a write and
   after a clone. Clone depth, command timeout and search result count are bounded by configuration.

7. **Every operation still passes the existing gate.** Real tools are registered in the same
   registry, declare the same permissions and pass through the same `ToolPermissionValidator`. Phase
   2 adds no new path to execution.

## Consequences

The agent becomes genuinely code-aware: it detects the Odoo series from the repository's own
manifests, lists the modules that actually exist, searches real source, and plans against paths that
are really there. The diff a user reviews is a real diff.

The cost is that the platform now writes to disk and reaches the network, so the controls above are
load-bearing rather than advisory. They are unit-tested directly, and the tests assert refusal
rather than success — a path-containment test that only checks the happy case would be worthless.

Risk A is untouched. Nothing in this ADR permits the execution of repository or AI-authored code,
and the absence of any shell tool remains asserted by test.

## Retirement condition

Retired together with ADR-013, when a Firecracker or Kata provisioner exists and the validation
tools become real inside it. The controls above remain necessary after that: a microVM bounds the
damage from executing untrusted code, but it does not make an unvalidated path or an unquoted
argument safe.
