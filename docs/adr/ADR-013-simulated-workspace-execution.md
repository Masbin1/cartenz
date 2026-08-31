# ADR-013 — Simulated workspace execution

**Status:** Accepted · **Date:** 27 August 2026 · **Milestone:** Phase 1

## Context

ADR-06 of the approved selection record requires that per-task execution of AI-generated code occur
inside a hardware-isolated Firecracker microVM, deployed through Kata Containers on Kubernetes,
because AI-generated code must be treated as untrusted and a shared-kernel container is an
insufficient boundary. Chapter 8 of the Technical Architecture repeats this as a warning.

The foundation milestone requires a working task lifecycle, not real code execution. Executing
AI-generated code on the development host — with no microVM, no kernel boundary and no egress
control — would breach the central security property of the architecture in order to deliver a
capability the milestone does not ask for.

## Decision

No untrusted code is executed anywhere in this milestone. Every tool that would touch a filesystem,
a shell, a Git remote or an Odoo runtime is implemented as a deterministic simulation behind the
ToolExecutor interface, and is registered in the same tool registry that will later hold the real
implementations. The simulated executors are named with a Simulated prefix and record
`simulated: true` on every action, so that no reader of the audit trail can mistake a simulated
result for a real one.

WorkspaceManager is the seam at which isolation will be introduced. Its foundation implementation
allocates a workspace record and an AI branch name in the documented
`ai/task-{task_id}-{short-description}` format; it does not create a directory, clone a repository
or start a process.

The following are explicitly not implemented, and are not stubbed in a way that could be enabled by
configuration: arbitrary shell execution, production database access, production deployment, and
outbound network access from a workspace.

## Consequences

The lifecycle, the permission validator, the approval flow and the audit trail are all exercised end
to end and can be tested, while the untrusted-code boundary remains unbuilt rather than built badly.
The cost is that the tool implementations are placeholders whose real versions must still be written
against the same interfaces.

## Retirement condition

Retired when a Firecracker or Kata workspace provisioner exists, WorkspaceManager provisions real
isolated workspaces, and the simulated executors have been replaced. Real repository operations
(Phase 2) must not be enabled ahead of the isolation boundary for anything beyond read-only
operations on a platform-managed clone.
