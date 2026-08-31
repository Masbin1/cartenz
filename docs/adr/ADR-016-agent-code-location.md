# ADR-016 — Location of agent code

**Status:** Accepted · **Date:** 27 August 2026 · **Milestone:** Phase 1

## Context

The Technical Architecture describes the location of the agent implementation in two places, and they
do not agree.

Chapter 5 sets out the back-end layout with the agent inside the NestJS application, listing
`agents/`, `tools/` and `workers/` as directories under `backend/src/`.

Chapter 16 sets out the monorepo layout with the agent as a sibling of the back end, listing
`frontend/`, `backend/`, `agent/`, `connector/`, `infrastructure/` and `docs/` at the top level.

Both cannot hold. The agent orchestrator, the tool execution layer and the permission validator are
the same code path that the API guards and the worker both depend on; the choice determines whether
that code is shared by import or duplicated across a package boundary.

## Decision

The agent implementation lives at `backend/src/agent/`, per chapter 5. There is no top-level `agent/`
package.

The determining consideration is the security boundary. The permission validator described in
chapter 7 must be the single gate through which every tool request passes, and the authorisation
service described in chapter 11 must be the single place authorisation is decided. Both are consumed
by the API process and the worker process alike. Holding them in one compilation unit makes a bypass
a compile error; splitting them across packages makes it a review oversight.

The API and the worker are two entry points into the same back-end application — `backend/src/main.ts`
and `backend/src/worker.ts` — and are deployed as separate processes from the same build, as the
Compose definition shows. This satisfies the deployment separation chapter 16 is describing without
duplicating the security-critical code.

The `connector/` package remains a top-level sibling as chapter 16 specifies. Its separation is not a
matter of preference: it is a Python application that runs on customer infrastructure, and ADR-10 is
explicit that it communicates over a contract-first, language-neutral protocol.

## Consequences

One compilation unit covers the API, the worker and the agent, so the tool and permission layers
cannot be circumvented by importing around them. Should the agent later need independent deployment
or scaling, it can be extracted into a workspace package; the internal module boundaries in
`backend/src/agent/` are drawn to keep that extraction mechanical.
