# ADR-074: A conversation remembers its earlier turns

- Status: Accepted
- Date: 19 October 2026
- Milestone: Phase 5 (review)

Builds on ADR-029 (conversational agent mode), ADR-047 (the workspace history
lists conversations, not requests) and ADR-053 (an approved chat write lands).
Amends ADR-029, which declared the mechanism and never wired it.

## Context

The operator reported that the workspace's Chat and Change flow "has no
memory": inside one conversation, a follow-up such as "explain what you said
before" received a vague, unrelated answer.

The cause was a gap between design and code, not model quality:

- Every message in the workspace creates a new `agent_tasks` row. ADR-047 groups
  those rows into a conversation through `agent_tasks.session_id`, so the portal
  shows one thread.
- ADR-029 declared `ChatLoopInput.conversationContext` — "earlier turns of the
  conversation this task belongs to" — and `ChatLoop.buildParts` renders it.
- Nothing ever filled it. `AgentWorkflow.implementChat` did not pass it,
  `TaskRepository.snapshot()` did not read the session, and the change-request
  planner had no such input at all. `grep conversationContext` over the backend
  found only the declaration and the empty loop.

Every message therefore reached the model as the first message of a new
conversation. The thread the person saw in the portal was never the thread the
model saw.

## Decision

### 1. Per-conversation memory is read from the tasks that already exist

No new table and no migration. A conversation's history is the session's earlier
`agent_tasks` rows, which already hold everything worth remembering:

| Turn element | Column |
| --- | --- |
| What the person asked | `prompt` |
| What the agent answered | `answer` (chat reply, or a change task's completion line) |
| Why a turn failed | `failure_reason` |
| What a change task planned | `plan->>'summary'` |
| What a change task touched | `modified_files[].path` |

`TaskRepository.loadConversationTurns(taskId, sessionId, maxTurns)` reads them:
same `session_id`, `created_at` strictly before the current task, oldest first.
A task without a session reads nothing. The snapshot now carries `sessionId`.

### 2. History is rendered as one bounded prompt part

`buildConversationContext()` (`backend/src/agent/orchestration/conversation-context.ts`)
is pure and renders the turns as a single part labelled
"Earlier in this conversation (oldest first)", placed directly after the current
request. Budget (`DEFAULT_CONVERSATION_BUDGET`):

- at most 20 turns, 24,000 characters in total;
- one prompt shortened past 3,000 characters, one answer past 4,000, each marked
  `[shortened, N more characters]`;
- when the total is exceeded, the oldest turns are dropped first and the part
  states how many were omitted, so the model can say it no longer has them
  rather than invent them;
- a turn with no answer and no failure says so — nothing is fabricated.

The part is marked trusted (`untrusted: false`): it is the person's own words and
the platform's own recorded answers, not repository content. It still passes the
AI data boundary like every other part, so credentials are redacted on the way
out.

### 3. Both Chat and Change receive it

- Chat: `implementChat` passes `conversationContext` to `ChatLoop.run`.
- Change: both planning paths (`createPlan` for repository projects,
  `createOdooOnlinePlan` for Odoo Online) accept and render it, so "now build
  what we discussed" plans against the discussion.

The implementation loop does not receive it: it executes an approved plan, and
the plan already carries whatever the conversation contributed. Adding the
history there would spend context on material the person already reviewed.

### 4. Reading history never fails a task

`AgentWorkflow.conversationContext()` catches a read error, logs a warning and
returns no history. Memory is context, not a precondition; the worst case is the
behaviour that existed before this ADR.

## What is deliberately not done (phase 2)

- **Project-wide memory across conversations.** `project_memory` already exists
  but holds only the analyser's technical facts (modules, Odoo version,
  structure). Distilled knowledge from conversations — decisions, conventions,
  the person's preferences for this project — needs its own write path (who
  writes it, in what shape, how it is bounded and corrected). That is a separate
  ADR, proposed after this one is observed in use.
- **Summarising old turns with a model.** Dropping the oldest turns with an
  explicit count is honest and free; a summarising call adds cost and a second
  place to be wrong. Revisit only if long conversations prove the 20-turn window
  too short.
- **Tool results from earlier turns.** Only prompts, answers, plans and changed
  paths are carried. Earlier file reads are not replayed; the model reads the
  repository again when it needs to, which keeps the history small and current.

## Consequences

- A follow-up inside one conversation reaches a model that has seen the earlier
  turns, for both kinds of task.
- Each call carries up to ~24k extra characters (~6k tokens) on a long
  conversation; a fresh conversation carries nothing extra.
- `TaskExecutionSnapshot` gains `sessionId`; every snapshot consumer compiles
  unchanged because the field is additive.

## Verification

- `grep -n "conversationContext: await this.conversationContext(snapshot)"
  backend/src/agent/orchestration/agent-workflow.ts` returns three lines (chat,
  repository planning, Odoo Online planning).
- `npx jest --testPathPattern=conversation` in `backend/` passes
  (`conversation-context.spec.ts`, `task-repository-conversation.spec.ts`).
- Live: in one conversation send a question, wait for the answer, then send
  "jelaskan jawabanmu sebelumnya". The second task's answer refers to the first
  answer's content. The first task's reference appears in the prompt the
  provider received (`agent_model_calls.input_tokens` rises against a first
  message of similar length).
