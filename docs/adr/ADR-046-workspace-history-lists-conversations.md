# ADR-046: The workspace history lists conversations, not requests

- Status: Accepted
- Date: 16 September 2026
- Milestone: Phase 5 (Odoo-aware development)

Builds on ADR-029 (task kinds), and on the session model already in the schema
(`agent_sessions`).

## Context

Every prompt submitted to the agent creates a task, and the workspace's history
pane listed one entry per task. A single working conversation of six exchanges
therefore produced six near-identical rows, ordered by timestamp, each opening
on its own page — while the conversation they belonged to existed in the data
(`agent_sessions`) and nowhere in the interface. The user described the symptom
and the fix:

> *"selagi belum new session, maka task historynya cuma 1 gitu. … task history
> ini hanya menampilkan session nya saja, kalo kita klik session yang udah
> lewat, ya kita balik ke context pembicaraan di session itu."*

The expectation is a chat assistant's, and it is the right model here: a session
is the unit a person thinks in. A task remains the unit the platform *executes*
in — every request is still a run with its own states, tool calls, approvals and
diff — but the surface that presents history should present conversations, and
the detail of a run should follow the turn selected inside one.

The backend already had the supporting fact. `agent_sessions` rows exist, every
task carries a `session_id`, prompts continue the current session by default,
and a new session is created only when the person asks for one. What was missing
was one endpoint shaped for a sidebar, one filter shaped for a thread, and a
workspace that uses them.

## Decision

### 1. The session list endpoint reports what a sidebar needs

`GET /projects/:id/sessions` (existing path, new shape) returns each
conversation with, per row: its title, its request count, its last-activity
time, and the status and prompt of its most recent request. The aggregates come
from one grouped query over the project's sessions rather than per-row reads, so
a sidebar of fifty conversations is two queries, not fifty-one.

### 2. The task list accepts a session filter, and orders as a thread

`GET /projects/:id/tasks?sessionId=…` returns one conversation's requests
**oldest first** — the order a conversation is read in — while the unfiltered
list keeps its newest-first order for "most recent work" listings. The session
id is validated against the project before anything is read: an id from another
project is refused, not silently narrowed to nothing.

### 3. The workspace's history pane lists conversations

The left pane lists sessions (title, request count, relative last-activity,
latest status). The centre pane renders the open conversation as a thread: each
turn is the prompt as asked, with a chat task's answer beneath it. Selecting a
turn is what the right-hand inspector, the activity stream and the diff follow —
so scrolling back to an earlier request still shows that request's own run.

The URL carries `?session=…&task=…`, so a reload reopens the same conversation
at the same turn.

### 4. A conversation is opened by the next prompt, exactly as before

No change to the creation flow: submitting a prompt with no open session opens
one server-side (the existing behaviour), and the response's `sessionId` is what
the workspace then shows. The "New conversation" control clears the open
session; the next prompt starts the new one. Sessions are never edited,
renamed or deleted by this decision.

## Consequences

- The workspace reads like a chat assistant: one entry per conversation, and
  clicking an old one restores its context. Six exchanges are one row with a
  count, not six rows.
- Requests remain fully independent tasks underneath — every one still has its
  approvals, validation and diff, reachable by selecting its turn.
- `TaskSummary` gains `sessionId` and, for chat tasks, `answer`; the thread
  renders from the summary list without fetching full detail per turn. A turn
  whose run is selected is fetched in full, as before.
- The unfiltered task list is unchanged for every other consumer; the new
  filtering and ordering apply only when `sessionId` is sent.
- Older deep links with only `?task=…` still resolve: the task's session is
  derived, and the conversation opens at that turn.

## Verification

- Unit: `listSessions` carries taskCount, lastActivityAt and latestStatus per
  row from grouped queries; an empty project returns `[]` without touching the
  task table. `listForProject` validates a session id against its project and
  refuses a foreign one; the unfiltered list performs no such check.
- End-to-end: a project with three sessions and seven requests shows three
  entries in the workspace history; opening the second shows its requests
  oldest-first, and selecting the first turn shows that turn's activity and
  inspector state.
