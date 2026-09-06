# ADR-029 — Conversational agent mode with inline write approval

**Status:** Accepted · **Date:** 4 September 2026 · **Milestone:** Post-Phase-5 UX · **Amends:** ADR-018 (adds one transition), ADR-021 (reuses the approval gate for a new action)

## Context

The agent surface is a development run. Every prompt creates a task that must pass
through plan approval and must end in a code change; a question such as "what does this
module do?" reaches the implementation loop, changes nothing, and is honestly reported as
`failed: the agent reported completion but made no change to the working tree`.

That is the right behaviour for a change platform, but it is the wrong shape for the most
natural first contact a person has with an agent: ask something, read something, get an
answer, and only later decide to change code. A user who opens the workspace and types a
question should receive an answer, not a failed task.

The engine already has every part this mode needs. `ModelImplementationLoop` runs the model
against the tool layer with a step budget; `ToolExecutionService` already suspends a task
(`ApprovalRequiredError`) when a tool needs a human decision, and the orchestrator resumes it
after the decision (ADR-011); `agentSessions` already groups tasks into a conversation. This
ADR adds a second *kind* of task that walks a shorter path through the same machinery, and
does not invent a parallel one.

## Decision

### 1. A task has a `kind`: `change` or `chat`

`agent_tasks` gains `kind`, default `change`. `change` is the existing development run,
unchanged. `chat` is conversational: the agent reads freely, answers in natural language, and
may propose file edits.

### 2. A chat task skips plan approval and may complete without a code change

The plan gate exists because a code change to a repository or a live instance must be reviewed
before it happens (ADR-021, ADR-028). A conversation does not change anything by itself, so it
has no plan gate. The "made no change to the working tree" failure applies only to `change`
tasks; a chat task that answered a question and changed nothing completes successfully.

The chat task's deliverable is a natural-language answer. It is stored on the task (`answer`
column) and narrated into the action log, so the reply survives the destroyed workspace exactly
as a diff does.

### 3. Reads are free; a write requires inline approval

The agent's read tools run without interruption, because reading the repository is what lets the
agent answer. The moment the agent intends to change a file, the same approval mechanism that
guards every other effect is invoked: the write tool requires approval, the loop suspends, a
person approves or rejects inline, and the orchestrator resumes. There is no chat-only write
path — a chat task writes through `ToolExecutionService` exactly as a change task does, so the
permission validator, the AI data boundary, and the process chokepoint all apply unchanged.

The new approval action is `chat_edit`. Its gate stands in front of the write tools in chat mode
and nothing else: `file_deletion` and `git_push` keep their existing gates, and a chat task
never commits or pushes.

### 4. The state machine reuses `implementing` for the chat loop

A chat task walks `created → queued → analyzing → implementing → completed`, branching on
`kind` at the point a change task would plan. `analyzing` is shared (clone, detect Odoo,
search), because a good answer and a good plan start from the same understanding of the
repository. `implementing` is reused as the name of the loop step even though a chat task has
no approved plan: it is still the step in which the model acts through tools. This adds one
transition, `analyzing → implementing`, documented here as amending ADR-018.

A write approval suspends the task into `waiting_approval` (existing) and resumes into
`implementing` on approval, which the transition table already permits.

## Consequences

The workspace becomes conversational without weakening a single security guarantee: a chat task
that never writes is read-only by construction, and a chat task that writes has passed the same
validator, approval and chokepoints as any change task. The cost is one column, one enum, one
transition, one approval action, a chat loop and a chat surface — and a second kind that every
reader of a task must account for, which is the honest cost of two product shapes on one
orchestrator.

A chat task cannot commit or push; a person who decides "now do it" writes a change task and
gets the reviewed path. The two kinds share a session, so the conversation and the change it
leads to are one continuous history rather than two silos.

## Retirement condition

The `kind` split is not a stopgap. It is retired only if the platform abandons the change-review
workflow entirely, which would mean ADR-021 is retired — not a condition anyone expects.
