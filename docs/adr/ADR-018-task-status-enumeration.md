# ADR-018 — Task status enumeration

**Status:** Accepted · **Date:** 27 August 2026 · **Milestone:** Phase 1

## Context

Chapter 6 of the Technical Architecture states the permitted task states in prose as: created,
queued, analyzing, planning, waiting_approval, implementing, testing, failed, cancelled and
completed. Table 4 repeats the same ten values.

The state diagram in the same chapter, however, shows the lifecycle passing through COMMITTING,
PUSHING and BUILDING before COMPLETED. Chapter 13 describes the Odoo.sh flow as push, then build
detection, then platform build monitoring. Phase 5 of the roadmap is titled Git automation and covers
commit, push, pull request and build monitoring.

The prose list and the diagram in the same chapter therefore disagree. A task that is pushing a
branch to a customer repository, or waiting on an Odoo.sh build, has to be in some state, and under
the ten-value list the only available answer is `testing` — which would mean the platform reports a
state it is not in, on the surface a user watches to decide whether to intervene.

## Decision

Thirteen states are implemented: the ten stated in the prose, plus `committing`, `pushing` and
`building` as shown in the chapter 6 diagram.

The enumeration and its transition table are declared together in
`backend/src/agent/task-state.ts`, deliberately not alongside the other enumerations in
`core/enums.ts`. Holding them in one file means a state cannot be introduced without also declaring
how a task reaches it and how it leaves. Every status write passes through `assertTransition`.

Three transitions in the table go beyond the linear diagram and are recorded here as intentional:

1. `testing -> implementing`, so that a failed validation can be repaired within the same task
   rather than obliging the user to raise a new one. The diagram shows validation failure moving to
   `failed`; that remains permitted and is the outcome when repair is not attempted.
2. `committing -> waiting_approval`, because chapter 11 requires human approval before a push
   leaves the platform. Without this transition the second approval gate could not be represented.
3. `waiting_approval -> pushing`, the return edge for that second gate. Because two gates suspend
   into the same state, `waiting_approval` has two exits, and which one applies is decided by the
   approval that was granted rather than by the transition table. A state machine with a single
   approval state and multiple gates necessarily has this shape; the alternative — a distinct
   waiting state per gate — would multiply states without adding information.

## Consequences

The state a task reports is the state it is in, and the Git automation phase can be implemented
without either adding states later or overloading `testing`. The divergence is confined to one file
with one entry point for writes.

Chapter 6 and Table 4 of the Technical Architecture should be reconciled to thirteen values at the
next revision, matching the diagram the chapter already contains.
