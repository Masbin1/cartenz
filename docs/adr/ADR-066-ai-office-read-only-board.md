# ADR-066: AI Office is a read-only board over tasks, not a multi-agent runtime

- Status: Accepted
- Date: 26 September 2026
- Milestone: Phase 5 (connected-server estate)

## Context

The operator brought an epic, "Cartenz AI Office - Real-Time AI Agent Workforce
Visualization", written for a system with a separate Hermes orchestration
runtime that dispatches specialist agents (Research, Developer, QA, Git,
Deployment) in parallel, and asked for it to be fitted to what Cartenz actually
is ("sesuaikan dengan hermes").

What Cartenz actually is (PRD `docs/AI-OFFICE-PRD-draft.md` §2):

- One task is run by one agent through a fixed, sequential state machine
  (ADR-018, `backend/src/agent/task-state.ts`): created → queued → analyzing →
  planning → waiting_approval → implementing → testing → committing → pushing
  → building → completed / failed / cancelled.
- "Hermes" in this codebase is one of the selectable LLM providers in
  Settings, alongside the others. It is not an orchestrator the backend talks
  to, and there is nothing called a Research Agent or QA Agent to adapt.
- The pieces the epic proposes to build already exist: a WebSocket gateway
  (`TaskEventsGateway`, `/ws`), typed task events, an append-only action log
  (`agent_actions`), and approvals with web push (ADR-065).

Building the epic as written would mean either inventing agents the platform
does not run - which is the "fake animation" the epic itself forbids - or
redesigning task execution into a parallel multi-agent runtime, which is a far
larger change than a visualisation and was not what was asked for.

## Decision

The AI Office is a **read-only board over existing tasks**, delivered in
phases. Phase 1 (this ADR):

- **Route and navigation.** `/ai-office` in the primary navigation, beside
  Overview and Projects.
- **Columns are lifecycle phases, not departments of agents.** Research =
  created/queued/analyzing/planning/waiting_approval; Development =
  implementing; Quality = testing; Operations = committing/pushing/building
  (and the terminal states, which never appear on the live board). The
  mapping lives in one pure function, `phaseFor`, with tests.
- **A card is a task.** Project, prompt, status, a progress bar derived from
  the task's position on the happy path of the state machine (never from a
  timer), and a one-line summary of the last recorded action.
- **Action summaries never carry reasoning or content.** `reasoning` rows are
  never surfaced. For a tool call, only its name and - for file tools - the
  file path are read; the query selects `input->>'path'` and `output->>'to'`
  rather than whole JSON columns, so file contents, Odoo records and command
  output never leave the database for this view.
- **"Waiting on you"** lists pending approvals on reachable tasks and links to
  the existing review page. The board itself cannot approve anything: approval
  stays on the existing routes and policy engine.
- **Scope.** The rule that decides whether a task can be opened at all
  (`decideProjectAccess`, ADR-043): admin sees everything; everyone else sees
  projects they created or were granted. Region alone is not enough - a
  same-region project is listed but locked, and its prompts must not leak onto
  the board. No new permission.
- **Two endpoints, both GET:** `/api/v1/ai-office/board` (live cards capped at
  200 + a summary of live / pending approvals / completed today / failed today)
  and `/api/v1/ai-office/attention`.
- **No schema change.** No migration, no new tables; reads only from
  `agent_tasks`, `agent_actions`, `approvals`, `projects`, `project_members`.

## Phase 2: realtime, without a second gateway

The board stayed a snapshot-on-refresh through phase 1. Phase 2 reuses
`TaskEventsGateway` (`/ws`) instead of standing up a second channel:

- **New subscription kind, not a new gateway.** A socket now sends
  `{action: 'subscribe', scope: 'ai-office'}` in addition to the existing
  per-task subscription. The gateway resolves the socket's readable project
  set once (`AuthorizationService.readableProjectIds`, the same call
  `decideProjectAccess` is built on), caches it for 60s, and on every task
  event checks the event's task against that set before relaying it. An admin
  gets a set that matches every project id, so nothing is filtered for them.
- **The event payload the browser stores is never the raw message.** The page
  keeps only what phase 1's REST response already exposes - status, a
  progress recompute, the last action's name and path - and re-derives the
  card from a debounced refetch of the REST endpoints on relevant
  events, rather than parsing and trusting the socket payload as UI state.
  This keeps the "no reasoning content in the browser" rule from phase 1
  intact for the realtime path too.
- **A denial is cached, like an approval is.** A task outside the socket's
  scope is checked once and the negative result is kept for the same 60s, so
  a socket cannot use the feed to enumerate task ids across projects it
  cannot read.
- **Reconnect is the client's job.** The hook reconnects with bounded
  exponential backoff (1s doubling to 15s), resubscribes to `ai-office`, and
  refetches the REST endpoints, because events missed while disconnected are
  gone. While disconnected the indicator reads "Reconnecting" rather than
  "Live", so a stale board is never presented as current. There is no timer
  polling; the Refresh button remains for a manual re-read.

## Phase 3: approval queue, activity feed, task drawer

- **`/api/v1/ai-office/queue`** adds worker capacity (from the same
  concurrency limit the orchestrator enforces) and the tasks currently waiting
  for a free worker, so "why hasn't my task started" has an answer on the
  board itself.
- **`/api/v1/ai-office/activity`** is a keyset-paged, project-scoped read of
  `agent_actions` joined to task and project name - the same fields
  `describeAction` already produces for a card, listed chronologically instead
  of per-task. It carries no `reasoning`, no raw `input`/`output`, only the
  same name/path summary the card's "last action" line uses.
- **The task drawer** is the existing card's full detail opened in a side
  panel, not a new data shape: prompt, current action, progress, and a link to
  the real task page. It reads only fields the board already had.

## Phase 4: the office as a scene

The columns become drawn rooms and a card becomes a person at a desk, all
inline SVG rather than image assets, for three reasons: no licensing question,
no asset pipeline, and the figure's pose can be driven directly by the task's
own status instead of a sprite sheet.

- **A room is drawn, not just a list.** Each phase's column is a small scene in
  a 280x250 viewBox: back wall, window, wall clock, plant, and furniture that
  suits the phase (bookshelf for Research, code board for Development, test
  checklist for Quality, server rack for Operations). Four desk slots, two rows
  of two; a fifth task is counted (`+N`), not squeezed in, because a tighter row
  stops reading as an office.
- **Room decoration is the only thing that is purely visual.** The ceiling
  light, skirting and floor planks carry no state. Two decorations do: the wall
  clock draws the *viewer's* real local time (there is a real time zone on the
  page and it would be odd to fake one), and the Operations server rack's status
  LEDs blink only while an Operations task is running in that room.
- **One figure is one running task, never a named or persistent agent.** A
  desk exists only while its task exists in that phase; there is no roster of
  agents to keep in sync with reality, because there is no roster - avoiding
  exactly the "invented agents" failure mode ADR-066's Context section
  rejected for the epic as originally written.
- **An idle office still shows its furniture.** With no live task the floor is
  correctly empty, but "all four rooms, all desks empty" is a legible quiet
  office, whereas an empty grey rectangle read as a broken page.
- **"Just finished" is a short tail, not history.** `recent` (3 hours, capped
  at 12) lists tasks that ended, each as a figure standing back from its desk,
  so a viewer who watched a desk empty sees where the person went. The activity
  feed remains the place to browse history; this strip is why the live board
  does not look as if the work simply evaporated.
- **Pose comes from `AgentTaskStatus`, one function (`poseFor` in
  `AgentFigure`), five poses:** `created`/`queued` sits back and thinks (the
  task exists but no agent has picked it up); `analyzing` through `building`
  (i.e. anything actually running) types with a moving arm and a lit screen -
  `agent_actions` does not distinguish "writing code" from "running a build"
  finely enough for a different animation per status to be honest, so every
  live state shares one working pose; `waiting_approval` sits back with a
  raised hand and a pulsing halo (the only state with a persistent visual
  call-to-action, matching "Waiting on you"); `completed` leans back
  relaxed; `failed`/`cancelled` leans back with a lowered head. Terminal
  states (`completed`/`failed`/`cancelled`) are not on the floor at all -
  the board query returns live tasks only - so those two poses exist for a
  task that finishes while its drawer is open, until the next refetch removes
  its desk.
- **Reduced motion is respected.** Every pose animation is disabled under
  `prefers-reduced-motion: reduce`; the pose is still conveyed by posture and
  colour, not only by movement.
- **The scene is data, not decoration.** Nothing moves that is not the direct
  rendering of a status enum already covered by phase 1's tests
  (`ai-office-board.spec.ts`); there is no separate "animation state" that
  could drift from the task's real status.

## Phase 5: the spatial floor, and a renderer boundary

The operator's visualisation task asked for an isometric office with Hermes at
the centre coordinating named agents, lines between collaborating agents, and
an architecture that lets a 3D renderer replace the 2D one later. The first two
describe a system Cartenz is not (see Context), so they were kept to what is
real; the rest was built as asked.

- **A mapping layer the renderer cannot see past.** `frontend/lib/office/`
  holds the office's own model: `status.ts` (task status to office status,
  glyph, label, and the previous room of a step), `model.ts` (the board, queue,
  attention and activity read models to `OfficeModel`: agents, departments,
  dispatch node, connections, totals), `store.ts` (the realtime reducer),
  `layout.ts` (where rooms and desks sit on the floor) and `camera.ts`
  (pan/zoom as a reducer). Everything there is pure and tested with
  `node:test` (`npm test` in `frontend/`). The SVG components in
  `components/ai-office/` take `OfficeModel` and report clicks; none imports an
  API type. A Three.js renderer would draw the same `OfficeModel`.
- **The centre of the floor is the worker pool, labelled "Dispatch".** Hermes is
  one LLM provider among several (ADR-018), so drawing "Hermes Orchestrator"
  would name an architecture that does not exist. What does exist is a fixed
  number of worker slots (`AGENT_WORKER_CONCURRENCY`) that pick queued tasks
  up; the ring around the node fills with how many of those slots are held,
  and pulses only while a task is actually changing state.
- **A connection is a real step, never agent-to-agent.** Each live task
  contributes one edge: from the room it just left to the room it is in (the
  previous status in the state machine), or from Dispatch for a task that has
  not yet walked anywhere. The line flows only while the task is running or has
  just moved. There are no edges between tasks, because tasks do not
  collaborate.
- **A figure is named by its work.** The label is project and task reference,
  never a persona ("Odoo Developer Agent"); the status chip under every figure
  repeats the status as a glyph and a word, so colour is never the only signal.
- **Realtime as a reducer.** `officeReducer` replaces the hook's ad hoc state:
  a REST snapshot replaces everything; an event may move a card the floor
  already holds to its new status at once (so the figure walks without waiting
  for the refetch), but can never create a card; event `message` text is never
  stored; a late or duplicate event (by per-task `sequence`) is dropped. A
  resync is still scheduled after every event, and on reconnect and when the
  tab becomes visible again.
- **Filters subdue, they do not remove.** Department and project filters dim
  everything outside scope; the floor never looks as if it has fewer tasks than
  the backend reports. The project filter offers only projects on the floor.
- **Camera.** Zoom in/out/reset buttons, drag to pan, ctrl/⌘-wheel to zoom;
  clamped so the office cannot be lost off screen. The office fits the frame at
  the default camera, so zoom is never needed to use it.
- **Mobile is a list, not a shrunken floor.** Below 768px the same agents render
  grouped by room, approvals first.
- **Testing.** The frontend had no test runner. Rather than add Jest, jsdom and
  Testing Library, `scripts/run-tests.mjs` bundles each `*.test.ts(x)` with the
  esbuild that ships with Next and runs it under `node:test`; component tests
  assert on `renderToStaticMarkup` output.
- **Layout invariants are asserted, not eyeballed.** `layout.test.ts` checks
  that rooms do not overlap in floor space, that every desk a room is asked for
  sits inside it and never stacks on another, that the dispatch point is on
  open floor inside no room, that a route attaches to the room edge facing the
  other end rather than crossing a room to its centre, and that the world bounds
  contain every room corner and wall top - so moving a room in `ROOM_LAYOUT`
  cannot push it off-canvas.
- **A room grows desks to fit its occupants.** The floor draws
  `max(DESKS_PER_ROOM, occupants)`, because a task that a "full" room would
  leave undrawn is a fabrication by omission, which this ADR forbids as much as
  drawing a task that is not there. `model.test.ts` covers the fifth task in one
  room.

## Consequences

- The board cannot interfere with task execution: it writes nothing, adds no
  hook to the worker and changes no existing endpoint. Phase 2's realtime path
  reuses the existing gateway's connection and auth; it does not open a second
  port or a second auth path.
- The page is no longer a snapshot: `LiveIndicator` shows whether the realtime
  channel is connected; while it is not, the indicator says "Reconnecting"
  and the page resyncs from REST as soon as the socket is back.
- Anyone expecting "agents talking to each other" will not find it, because
  Cartenz does not do that. If parallel specialist agents are ever built, the
  board's columns can become real agents then; the card shape (one executing
  unit, its phase, its last action) does not have to change.
- Rejected alternative: a `HermesAdapter` and `ai_agents` / `ai_agent_runs` /
  `ai_orchestrations` tables from the epic. With one orchestrator and one agent
  per task they would duplicate `agent_tasks` and `agent_actions` row for row.
- Rejected for phase 4: image or photo-based avatars. An SVG figure driven by
  the status enum cannot show a pose the task is not actually in; a sprite
  sheet or stock illustration would need its own state mapping to keep honest,
  duplicating `phaseFor`/`poseLabel` for no benefit.
