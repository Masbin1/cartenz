# PRD: AI Office — a live view of the agent workforce across projects

| Field | Value |
| --- | --- |
| Document owner | Operator request, scoped by the platform engineer |
| Status | Draft — product brief for review; no ADR yet |
| Date | 26 September 2026 |
| Requested by | Pak Ferry (relayed by the operator) |
| Supersedes | The externally drafted "AI Office" epic, where it conflicts with the deployed architecture (see §2) |
| Depends on | ADR-018 (task state machine), ADR-052 (ephemeral preview instances), ADR-065 (web push), chapter 9 (realtime events) |

This brief restates the AI Office request in the shape the platform can actually
support. The externally drafted epic assumed an agent runtime with several
parallel specialist agents and a separate "Hermes" orchestration layer. That is
not what Cartenz is, and building to that draft would mean redesigning the task
execution core. §2 states the difference plainly; §4 onwards is the same product
ambition, expressed against the architecture that exists.

## 1. Problem

The portal shows a task as a status, a log and a diff. That is enough to operate
one task and useless for answering the question an operator actually has:
**what is the AI doing right now, across every project?** Today that question is
answered by opening projects one at a time and reading statuses.

Nothing visual exists for "the AI is working": no live board, no sense of motion,
no single place where an approval waiting on a person is obvious among work that
is progressing on its own.

## 2. What the request assumed, and what the platform is

Each row is a place the external epic and the deployed system disagree. These are
not preferences; they are facts about the code.

| The epic assumes | The platform actually is |
| --- | --- |
| A "Hermes Runtime" orchestrating research, development, QA and deployment agents in parallel | One agent per task, walking a fixed state machine (`analyzing → planning → waiting_approval → implementing → testing → committing → pushing → building → completed/failed`), defined in `backend/src/agent/task-state.ts` (ADR-018). One task on one project occupies one worker. |
| "Hermes" as an agent runtime Cartenz calls | "Hermes" appears in the codebase only as a *model provider* name (a local gateway option in Settings, alongside OpenAI/Anthropic/9router). It is not a runtime that dispatches agents. |
| New tables `ai_agents`, `ai_agent_runs`, `ai_orchestrations`, `ai_agent_events` | The equivalent facts already exist: `agent_tasks` (the run), `agent_actions` (2,692 rows — every tool call with status and duration), `agent_sessions`, `agent_model_calls` (provider, model, tokens, failure reason). |
| A new WebSocket/event bus | `TaskEventsGateway` already serves `/ws` with token auth, per-task subscribe and Redis fan-out; `TASK_EVENT_TYPES` already enumerates the event vocabulary including `agent_activity`, `tool_started`, `approval_required`, `task_status_changed`. |
| Departments as first-class entities with specialist agents | No such entity. However, the task states *are* the phases, and they map onto the requested departments honestly: `analyzing`/`planning` → Research, `implementing` → Development, `testing` → Quality, `committing`/`pushing`/`building` → Operations, `waiting_approval` → the human gate. |
| An `AgentRuntimeAdapter` abstraction over Hermes | No external runtime to abstract. The single orchestrator is `AgentWorkflow` / `QueueAgentOrchestrator`, already behind `AgentOrchestrator` interface — the seam the epic asks for exists and points at the platform's own orchestrator. |

Two consequences decide the whole design:

1. **The office shows real tasks, grouped by real phase.** No invented parallel
   work, no fake agents. If three tasks are running, three workers are shown —
   because that is what is true.
2. **The realtime layer is reused, not rebuilt.** Extending the existing gateway
   to a cross-project channel is a small change; a second event bus is not.

## 3. Goals

- One screen answers "what is the AI doing now?", across every project the
  viewer can see.
- Work that needs a person is visually separable from work that does not.
- Activity is real: every element is traceable to a row in `agent_tasks` or
  `agent_actions`, or to a realtime event the worker published.
- The screen is useful on a laptop at a glance, without reading logs.

## 4. The screen

```text
┌──────────────────────────────────────────────────────────────┐
│ AI Office                            ● Live   Last 24h: 14 ▾ │
│                                                              │
│ Active 3   Waiting on you 1   Failed today 2                 │
├──────────────────────────────────────────────────────────────┤
│ RESEARCH          DEVELOPMENT         QUALITY      OPS       │
│ ┌────────────┐    ┌────────────┐   ┌─────────┐  ┌─────────┐  │
│ │ MAHA       │    │ Linkederp  │   │         │  │         │  │
│ │ analysing  │    │ implementing   │ —       │  │ —       │  │
│ │ 02:14      │    │ 11:03      │   │         │  │         │  │
│ │ ▓▓▓░░      │    │ ▓▓▓▓▓▓▓░   │   │         │  │         │  │
│ └────────────┘    └────────────┘   └─────────┘  └─────────┘  │
│                                                              │
│ NEEDS YOU                                                    │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ Linkederp — push to staging awaiting approval    [Review]│ │
│ └──────────────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────────────┤
│ Activity (live)                                              │
│ → Linkederp  modified addons/sale_approval/models/…          │
│ ✓ Maha       validation passed (12 tests)                    │
│ ! Harleys    failed: provider refused (DeepSeek, 429)        │
└──────────────────────────────────────────────────────────────┘
```

- Columns are phases, not fabricated departments. Their names come from
  `TASK_STATUS_LABELS`, so the wording matches the rest of the portal.
- A card is one task. It carries project, current phase, elapsed time, the last
  real activity line, and progress derived from phase position — not from a
  timer.
- A viewer with one project sees one project. The board is scoped by the same
  `AuthorizationService` the rest of the portal uses: admin sees everything,
  everyone else sees only projects they hold access to.
- Empty means empty: with nothing running, the screen says so. It never animates
  a fake worker.

## 5. Data model

No new tables in the first phase. Everything is derived from what exists:

| Element on screen | Source |
| --- | --- |
| Card identity, project, phase, elapsed | `agent_tasks` (`status`, `project_id`, `created_at`, `updated_at`) |
| Current activity line | Latest `agent_actions` row for the task (`tool_name`, `action_type`, `status`) |
| Progress within a phase | Phase index in `AGENT_TASK_STATUSES` — a real position, not an animation |
| Needs-you queue | `approvals` where `status = 'pending'` |
| Failure reason | `agent_model_calls.failure_reason` / `agent_tasks.failure_reason` |
| Live deltas | Existing task events over the reused gateway |

A projection table (`agent_runs`, one row per task, denormalised for the board)
is **not** in the first phase. If the board cannot be served fast enough by
indexed queries against `agent_tasks` + a lateral join for the last action, that
is the moment to add it, with the measurement in hand.

## 6. API

New endpoints, read-only, all authorised per project:

```text
GET /api/v1/ai-office/overview          counts + system status
GET /api/v1/ai-office/board             tasks grouped by phase, project-scoped
GET /api/v1/ai-office/activity?before=&limit=   cursor-paged, from agent_actions
```

Realtime: extend `TaskEventsGateway` with a cross-project channel the client
subscribes to after authorisation (`subscribe` with `{ scope: 'ai-office' }`),
fanning out only events for projects the socket's user may see. The existing
per-task subscribe stays exactly as it is; push notifications (ADR-065) are
unaffected.

## 7. Explicitly out of scope

- Parallel specialist agents, agent-to-agent messaging, an agent registry of
  non-existent workers.
- A second event bus, a second WebSocket server, or any new queue.
- Isometric or 3D scenery as a functional requirement. Once the board is real and
  live, a spatial visual treatment is a presentation change on top of it — and
  only then, because dressing up a screen that shows nothing real is the failure
  mode this brief exists to avoid.
- Any display of model chain-of-thought. Summaries only: which phase, which tool,
  what changed.

## 8. Phases

| Phase | Deliverable | Independent value |
| --- | --- | --- |
| 1 | `/ai-office` route, board endpoint, cards grouped by phase, project filter | Replaces "open each project to see its status" |
| 2 | Realtime over the existing gateway + reconnect/resync (poll on reconnect, since events missed while disconnected are gone) | The board stops being a snapshot |
| 3 | Needs-you queue, activity feed with cursor paging, drawer with the task's real actions and diff link | Operate approvals from the board |
| 4 | Visual treatment (spatial layout, motion on real transitions) | Presence, plus approval follow-up |
| 5 | Isometric floor: drawn rooms and desks, a figure per live task, a dispatch node for the worker pool, connections as real state transitions, camera, filters, mobile list | The office is a place you can watch, not a list to read |

Each phase is independently shippable and each one is verified before the next
starts.

## 9. Open questions

1. Should the board show only live tasks by default, or also today's finished
   ones? (Affects whether the board feels like a control panel or a log.)
2. Is there a per-phase progress worth showing beyond phase position — e.g. the
   model's own step count (`agent_model_calls.steps`)? Only if it is honest.
3. Should a card link straight into the existing task page, or open a drawer
   first? The drawer duplicates task-page information; the link is cheaper.

## 10. Success criteria

- A person answers "what is the AI doing right now" in under five seconds,
  without opening a project.
- Every card, and every activity line, can be traced to a database row or a
  published event. Nothing on screen is invented, and the empty state is shown
  when nothing is running.
- A viewer never sees a project they have no access to, on the board or over the
  socket.
- Tasks, approvals, notifications and the existing task page behave exactly as
  before; this feature adds a view and takes nothing away.
