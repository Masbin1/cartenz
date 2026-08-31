# ADR-011 — Orchestration abstraction, with Temporal deferred

**Status:** Accepted · **Date:** 27 August 2026 · **Milestone:** Phase 1

## Context

ADR-05 of the approved Framework and Technology Selection adopts self-hosted Temporal as the durable
execution engine for the agent task lifecycle, principally because approval waits and long-running
tasks are fragile on a plain job queue, and because deterministic replay contributes to the audit
trail.

Temporal requires a cluster: a server, a persistence store, and a dedicated worker process. Standing
that up is a material infrastructure commitment, and it is not required to establish the foundation
that Phase 1 defines — Next.js, NestJS, PostgreSQL, Redis, authentication, projects and tasks. The
approved architecture also adopts Redis with BullMQ for job queuing and event fan-out, so a queue is
present in the target stack regardless.

The risk register in the selection record already directs that the model and agent concerns be kept
behind internal interfaces so that any single component can be replaced without touching domain
logic.

## Decision

The task lifecycle is driven through a single interface, AgentOrchestrator, declared in
`backend/src/agent/orchestration/agent-orchestrator.interface.ts`. The foundation binds a BullMQ
implementation, QueueAgentOrchestrator. A Temporal implementation will be bound in its place without
changes to any module that depends on the interface.

Three properties are required of the foundation implementation so that the substitution is a
like-for-like exchange rather than a rewrite:

1. State is persisted, not held in memory. Every transition is written to `agent_tasks` and appended
   to `agent_actions` before the next step begins. A worker restart resumes from the database, not
   from process memory.
2. The approval wait is a suspension, not a blocked process. On reaching `waiting_approval` the job
   completes. The approval decision enqueues a fresh continuation job. No worker holds an open
   handle across the human wait.
3. Transitions are validated centrally. AgentTaskStatus and its permitted transitions are declared
   once, in `backend/src/agent/task-state.ts`, and every write passes through assertTransition.

## Consequences

The foundation is operable on a single Redis instance, and the durable-execution decision is
deferred without being pre-empted. The cost is that deterministic replay is not yet available; the
`agent_actions` append-only log carries the audit obligation in the interim, which is sufficient for
the MVP scope but weaker than replay for post-incident reconstruction.

## Retirement condition

This ADR is retired when a Temporal deployment exists and TemporalAgentOrchestrator is bound in
place of QueueAgentOrchestrator. The interface, the state machine and the persistence contract above
are expected to survive that change unchanged.
