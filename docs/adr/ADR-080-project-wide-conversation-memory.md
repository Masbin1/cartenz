# ADR-080: A request sees the project's other conversations

- Status: Accepted
- Date: 19 October 2026
- Milestone: Phase 5 (review)

Builds on ADR-047 (the workspace history lists conversations, not requests) and
ADR-074 (a conversation remembers its earlier turns). This is the project-wide
memory ADR-074 deferred to phase 2.

## Context

ADR-074 gave a task the earlier turns of its own conversation. On 19 October the
operator then asked, from a **new** conversation, to summarise every conversation
of the Omnisurge project and to list which changes had succeeded or failed. The
answer was:

> Belum ada percakapan sebelumnya yang tercatat — ini adalah pesan pertama di sesi ini.

That sentence was true of the session and false of the project. The database held
three conversations and seven requests for Omnisurge, including the trip-KPI
change request whose commit was written and whose push was refused. The portal
listed them; the model had no way to see them.

The cause is the boundary ADR-074 drew on purpose: history was selected by
`agent_tasks.session_id`, so context that lived in a different conversation was
invisible even though the same project owned it. A design discussed on Tuesday
and executed on Thursday is exactly that case, and it is common — the workspace
opens a new conversation whenever a person starts a new thread.

The data model already supported the fix. `agent_tasks` carries `project_id`,
`status`, `prompt`, `answer`, `failure_reason`, `plan->>'summary'`,
`modified_files`, `commit_hash` and `created_at`; `agent_sessions` carries the
conversation title. No new table and no migration is needed.

## Decision

### 1. Read an index of the project's requests, not a transcript

`TaskRepository.loadProjectHistory(projectId, {excludeTaskId, sessionId?,
reference?, limit})` returns the project's `agent_tasks` rows, newest first,
left-joined to `agent_sessions` for the conversation title, excluding the task
that is asking. `countProjectHistory(projectId)` returns the project totals, and
`projectHistoryForPrompt()` bundles both.

The index is deliberately shallow: one entry per request, with the prompt, the
outcome (answer, failure reason, or an explicit "no answer recorded"), the commit
and the changed paths. Two hundred requests summarised at full length would
consume the context the answer needs; an index tells the model that a request
exists and how it ended, which is what "what has been discussed, tried or failed"
asks for.

### 2. Render it as one bounded prompt part

`buildProjectHistory()` (`backend/src/agent/orchestration/project-history.ts`) is
pure and renders a single part labelled "Earlier conversations in this project
(newest first)", placed directly after the per-conversation history of ADR-074.
Budget (`DEFAULT_PROJECT_HISTORY_BUDGET`):

| Bound | Value |
| --- | --- |
| Requests considered | 40 |
| Total characters | 10,000 |
| One prompt | 200 characters |
| One outcome | 300 characters |
| Files shown per request | 5 |

The header states how many requests and conversations the project holds and, when
the budget cut the list, how many older ones are not shown — so a model asked to
summarise the whole project can say what it cannot see instead of implying it saw
everything. The part is marked trusted (`untrusted: false`) for the same reason as
ADR-074: it is the project's own record, not repository content, and it still
passes the AI data boundary on the way out.

### 3. `read_project_history` for the detail

The index answers "what happened"; it cannot answer "what exactly did we decide".
`ProjectHistoryTools` (`backend/src/agent/tools/real/project-history.tools.ts`)
adds one model-callable tool:

- input: optional `reference`, optional `sessionId`, optional `limit`;
- output: the matching requests with their prompt and answer, plus the project
  totals and a `note` when nothing matched;
- its own limits, not the caller's: 20 requests, 2,000 characters of prompt and
  6,000 of answer per request, 40,000 in total — the answer goes straight back
  into the context the index was protecting.

It is `leavesPlatform: false` and needs no approval: it reads the platform's own
task record for the project it is already working on. It is not mode-gated, so an
`odoo_online` project can answer "what did we discuss" too.

### 4. One new permission, granted by default

`project_history_read` is added to `AGENT_PERMISSIONS` with a default of `true`.
Existing projects inherit it through `resolveAgentPermissions`, which merges the
stored JSON over the defaults rather than treating a missing key as denied. The
capability is the record the portal already shows to anyone who can open the
project, so it is not a capability a person has to discover; it exists so the
permission model stays exhaustive rather than because it should ever be off.

### 5. Both kinds of task, both planning paths

- Chat: `implementChat` passes `projectHistory` to `ChatLoop.run`.
- Change: `createPlan` (repository) and `createOdooOnlinePlan` (Odoo Online) both
  accept and render it.
- The chat and planning instructions now tell the model that the index exists,
  that it covers conversations other than the current one, and that
  `read_project_history` is how to read one in full. Without that sentence a model
  reads the part as background and still answers "I have no record of that".

### 6. Reading history never fails a task

`AgentWorkflow.projectHistory()` catches a read error, logs a warning and returns
no part — the same rule as ADR-074. Memory is context, not a precondition.

## What is deliberately not done

- **Distilled memory.** Decisions, conventions and preferences extracted from
  conversations ("module names follow `<project>_<app>_modifier`", "this project
  uses Staging, never main") still live only in the turns that stated them. A
  distilled store needs a writer, a shape, a correction path and a staleness rule;
  the index and the tool above make the raw record reachable first, and the
  distilled layer should be scoped from how that is actually used.
- **Search.** The tool narrows by request reference or conversation id, not by
  meaning. With 40 requests in the index and a project's history growing, keyword
  or embedding search over `prompt`/`answer` is the next real step; it needs an
  index and a relevance decision that this ADR does not make.
- **Cross-project memory.** A request reads its own project only. Reading another
  project's conversations would cross an access boundary the workspace does not
  currently draw for the agent.
- **Replaying tool results.** Only prompts, answers, plans, commits and changed
  paths are carried. Earlier file reads are not replayed; the model reads the
  repository again when it needs to.

## Consequences

- A request typed into a new conversation sees what the project has already
  discussed and attempted, without the person re-explaining it.
- Each call carries up to ~10k extra characters (~2.5k tokens) on a project with
  history; a project with no history carries nothing.
- One permission and one tool are added to the surface. The permission defaults
  on, so no existing project needs reconfiguring.
- The prompt index is bounded, so a project with more than 40 requests is
  represented by its most recent work plus an explicit count of what is omitted.
  That is a known limit, not a silent one.

## Verification

- `npx jest --testPathPattern="project-history|permission-validator|odoo-online-mode"`
  in `backend/` passes.
- `npx jest` in `backend/` passes in full (109 suites).
- `grep -c "projectHistory: await this.projectHistory(snapshot)" backend/src/agent/orchestration/agent-workflow.ts`
  returns 3 (chat and both planning paths).
- Live: open a project with earlier conversations, start a **new** conversation,
  and ask "rangkum seluruh percakapan yang pernah terjadi di sini, dan changes apa
  saja yang gagal dan berhasil". The answer names the earlier conversations and,
  for Omnisurge, the trip-KPI change that was committed but whose push was
  refused. It must not answer that no earlier conversation exists.
