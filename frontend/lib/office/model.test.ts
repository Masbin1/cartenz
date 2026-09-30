import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEPARTMENTS,
  DESKS_PER_ROOM,
  NO_FILTERS,
  TASK_TITLE_LIMIT,
  activityInScope,
  agentEmphasis,
  agentInScope,
  buildOfficeModel,
  clipTitle,
  departmentEmphasis,
  mobileAgents,
  projectsOnFloor,
  type OfficeFilters,
} from './model';
import {
  approval,
  board,
  card,
  event,
  finished,
  queue,
  PROJECT_MAHA,
  PROJECT_OMNI,
} from './fixtures';

const live = true;

test('an unloaded board is loading, not an empty office', () => {
  const model = buildOfficeModel({ board: null, attention: [], queue: null, live: false });
  assert.equal(model.status, 'loading');
  assert.deepEqual(model.agents, []);
});

test('a loaded board with no live task is empty but still draws every room', () => {
  const model = buildOfficeModel({
    board: board([], [finished('completed')]),
    attention: [],
    queue: queue(),
    live,
  });
  assert.equal(model.status, 'empty');
  assert.equal(model.departments.length, 4);
  assert.deepEqual(
    model.departments.map((d) => d.desks),
    [DESKS_PER_ROOM, DESKS_PER_ROOM, DESKS_PER_ROOM, DESKS_PER_ROOM],
  );
});

test('a live task with a closed socket reports reconnecting, not live', () => {
  const model = buildOfficeModel({
    board: board([card('implementing')]),
    attention: [],
    queue: queue(),
    live: false,
  });
  assert.equal(model.status, 'reconnecting');
});

test('the socket state is not consulted while the board is still loading', () => {
  const model = buildOfficeModel({ board: null, attention: [], queue: null, live: false });
  assert.equal(model.status, 'loading');
});

test('an agent is named by its work, never by an invented persona', () => {
  const c = card('implementing', { taskReference: 'TASK-41' });
  const model = buildOfficeModel({ board: board([c]), attention: [], queue: queue(), live });
  const [agent] = model.agents;
  assert.equal(agent.displayName, 'MAHA · TASK-41');
  assert.equal(agent.taskId, c.taskId);
  assert.equal(agent.runId, null);
});

test('a recorded action is shown as real, verbatim', () => {
  const c = card('implementing', { currentAction: 'Editing sale_approval/models/order.py' });
  const model = buildOfficeModel({ board: board([c]), attention: [], queue: queue(), live });
  assert.equal(model.agents[0].currentAction, 'Editing sale_approval/models/order.py');
  assert.equal(model.agents[0].currentActionIsReal, true);
});

test('with no recorded action the office says what the status honestly means', () => {
  const model = buildOfficeModel({
    board: board([card('queued')]),
    attention: [],
    queue: queue(),
    live,
  });
  assert.equal(model.agents[0].currentAction, 'Waiting for a free worker');
  assert.equal(model.agents[0].currentActionIsReal, false);
});

test('progress comes from the card and is never invented', () => {
  const model = buildOfficeModel({
    board: board([card('implementing', { progress: 0.78 })]),
    attention: [],
    queue: queue(),
    live,
  });
  assert.equal(model.agents[0].progress, 0.78);
});

test('the room is taken from the board, not recomputed', () => {
  const model = buildOfficeModel({
    board: board([card('testing')]),
    attention: [],
    queue: queue(),
    live,
  });
  assert.equal(model.agents[0].department, 'quality');
});

test('departments list their occupants in board order', () => {
  const first = card('implementing');
  const second = card('implementing');
  const model = buildOfficeModel({
    board: board([first, second, card('testing')]),
    attention: [],
    queue: queue(),
    live,
  });
  const development = model.departments.find((d) => d.id === 'development');
  assert.deepEqual(development?.agentIds, [first.taskId, second.taskId]);
  assert.equal(development?.busy, true);
  assert.equal(model.departments.find((d) => d.id === 'research')?.busy, false);
});

test('departments are the four fixed rooms in reading order', () => {
  const model = buildOfficeModel({ board: board([]), attention: [], queue: queue(), live });
  assert.deepEqual(
    model.departments.map((d) => d.id),
    DEPARTMENTS.map((d) => d.id),
  );
});

test('a fifth task in one room still gets a desk: no task goes undrawn', () => {
  const cards = Array.from({ length: 6 }, () => card('implementing'));
  const model = buildOfficeModel({ board: board(cards), attention: [], queue: queue(), live });
  const development = model.departments.find((d) => d.id === 'development')!;
  assert.equal(development.agentIds.length, 6);
  assert.ok(development.desks >= 6, 'the room must offer a desk for every occupant');
});

test('a queued task holds no worker slot and is not counted busy', () => {
  const model = buildOfficeModel({
    board: board([card('queued'), card('queued')]),
    attention: [],
    queue: queue({ capacity: 2, running: 0 }),
    live,
  });
  assert.equal(model.orchestrator.busy, 0);
});

test('an approval is attached to the task it blocks', () => {
  const c = card('waiting_approval');
  const model = buildOfficeModel({
    board: board([c]),
    attention: [approval(c)],
    queue: queue(),
    live,
  });
  assert.equal(model.agents[0].status, 'approval');
  assert.equal(model.agents[0].approval?.action, 'git_push');
});

test('a task without a pending approval carries none', () => {
  const model = buildOfficeModel({
    board: board([card('implementing')]),
    attention: [],
    queue: queue(),
    live,
  });
  assert.equal(model.agents[0].approval, null);
});

/* Connections: only real transitions, never an agent-to-agent mesh. */

test('a reading task runs from the dispatch point into its room', () => {
  const model = buildOfficeModel({
    board: board([card('analyzing')]),
    attention: [],
    queue: queue(),
    live,
  });
  const connections = model.connections;
  assert.equal(connections.length, 1);
  assert.equal(connections[0].from, 'dispatch');
  assert.equal(connections[0].to, 'research');
});

test('a queued task is on the dispatch line and not yet in a room', () => {
  const model = buildOfficeModel({
    board: board([card('queued')]),
    attention: [],
    queue: queue(),
    live,
  });
  assert.equal(model.connections[0].from, 'dispatch');
  assert.equal(model.connections[0].to, 'research');
  assert.equal(model.connections[0].active, false, 'a queued task is not moving');
});

test('a developing task is drawn walking from research into development', () => {
  const model = buildOfficeModel({
    board: board([card('implementing')]),
    attention: [],
    queue: queue(),
    live,
  });
  assert.equal(model.connections[0].from, 'research');
  assert.equal(model.connections[0].to, 'development');
});

test('agents never connect to each other', () => {
  const model = buildOfficeModel({
    board: board([card('implementing'), card('testing'), card('building')]),
    attention: [],
    queue: queue(),
    live,
  });
  for (const connection of model.connections) {
    const ends = [connection.from, connection.to];
    const rooms = ['research', 'development', 'quality', 'operations', 'dispatch'];
    for (const end of ends) assert.ok(rooms.includes(end), `${connection.id} has a non-room end`);
  }
});

test('two agents on the same route share one connection carrying both ids', () => {
  const a = card('implementing');
  const b = card('implementing');
  const model = buildOfficeModel({
    board: board([a, b]),
    attention: [],
    queue: queue(),
    live,
  });
  assert.equal(model.connections.length, 1);
  assert.deepEqual(model.connections[0].agentIds.sort(), [a.taskId, b.taskId].sort());
});

test('a finished task draws no connection', () => {
  const model = buildOfficeModel({
    board: board([], [finished('completed')]),
    attention: [],
    queue: queue(),
    live,
  });
  assert.deepEqual(model.connections, []);
});

test('only an agent that just changed status is drawn mid-walk', () => {
  const c = card('implementing');
  const still = buildOfficeModel({ board: board([c]), attention: [], queue: queue(), live });
  assert.equal(still.agents[0].justMoved, false);

  const moved = buildOfficeModel({
    board: board([c]),
    attention: [],
    queue: queue(),
    live,
    movedTaskIds: new Set([c.taskId]),
  });
  assert.equal(moved.agents[0].justMoved, true);
  assert.equal(moved.orchestrator.dispatching, c.taskId);
});

/* Dispatch (the orchestrator's real behaviour). */

test('dispatch counts worker slots from the queue endpoint', () => {
  const model = buildOfficeModel({
    board: board([card('implementing')]),
    attention: [],
    queue: queue({ capacity: 3, running: 1 }),
    live,
  });
  assert.equal(model.orchestrator.capacity, 3);
  assert.equal(model.orchestrator.busy, 1);
  assert.equal(model.orchestrator.state, 'idle');
});

test('dispatch reads saturated when every worker slot is held', () => {
  const model = buildOfficeModel({
    board: board([card('implementing'), card('testing')]),
    attention: [],
    queue: queue({ capacity: 2, running: 2 }),
    live,
  });
  assert.equal(model.orchestrator.state, 'saturated');
});

test('dispatch lists the queued tasks it has not placed yet', () => {
  const waiting = card('queued');
  const model = buildOfficeModel({
    board: board([waiting, card('implementing')]),
    attention: [],
    queue: queue({ capacity: 1, running: 1 }),
    live,
  });
  assert.deepEqual(model.orchestrator.dispatchQueue, [waiting.taskId]);
});

test('dispatch reads offline when the stream is down', () => {
  const model = buildOfficeModel({
    board: board([card('implementing')]),
    attention: [],
    queue: queue(),
    live: false,
  });
  assert.equal(model.orchestrator.state, 'offline');
});

/* Totals. */

test('totals count the floor by status', () => {
  const model = buildOfficeModel({
    board: board(
      [card('implementing'), card('testing'), card('waiting_approval'), card('queued')],
      [],
      { completedToday: 4, failedToday: 1 },
    ),
    attention: [],
    queue: queue(),
    live,
  });
  assert.deepEqual(model.totals, {
    agents: 4,
    running: 1,
    waiting: 1,
    approval: 1,
    queued: 1,
    completedToday: 4,
    failedToday: 1,
  });
});

/* Finished work. */

test('a finished task stands rather than sits, and never shows a timer', () => {
  const model = buildOfficeModel({
    board: board([], [finished('failed')]),
    attention: [],
    queue: queue(),
    live,
  });
  const [agent] = model.recent;
  assert.equal(agent.seated, false);
  assert.equal(agent.progress, 1);
  assert.equal(agent.status, 'failed');
  assert.equal(agent.currentActionIsReal, false);
});

test('the recent tail is kept even while the floor is busy', () => {
  const model = buildOfficeModel({
    board: board([card('implementing')], [finished('completed')]),
    attention: [],
    queue: queue(),
    live,
  });
  assert.equal(model.agents.length, 1);
  assert.equal(model.recent.length, 1);
});

/* Titles and clipping. */

test('a long prompt is clipped and loses its newlines', () => {
  const title = clipTitle(
    'Create\na sale   approval module that also reconciles invoices end to end',
  );
  assert.ok(title.length <= TASK_TITLE_LIMIT);
  assert.ok(title.endsWith('…'));
  assert.equal(title.includes('\n'), false);
});

test('a short prompt is left exactly as written', () => {
  assert.equal(clipTitle('  Add a field  '), 'Add a field');
});

test('the full prompt survives for the drawer and the title attribute', () => {
  const prompt = 'x'.repeat(200);
  const model = buildOfficeModel({
    board: board([card('implementing', { prompt })]),
    attention: [],
    queue: queue(),
    live,
  });
  assert.equal(model.agents[0].taskTitleFull, prompt);
  assert.ok(model.agents[0].taskTitle.length < prompt.length);
});

/* Filters subdue; they never delete. */

const withDepartments = () =>
  buildOfficeModel({
    board: board([card('implementing'), card('testing'), card('analyzing', PROJECT_OMNI)]),
    attention: [],
    queue: queue(),
    live,
  });

test('department filter focuses one room and dims the rest', () => {
  const model = withDepartments();
  const filters: OfficeFilters = { department: 'development', projectId: 'all' };
  const development = model.departments.find((d) => d.id === 'development')!;
  const quality = model.departments.find((d) => d.id === 'quality')!;
  assert.equal(departmentEmphasis(development, filters), 'focused');
  assert.equal(departmentEmphasis(quality, filters), 'dimmed');
});

test('dimming never removes an agent from the model', () => {
  const model = withDepartments();
  const filters: OfficeFilters = { department: 'development', projectId: 'all' };
  assert.equal(model.agents.length, 3);
  assert.equal(model.agents.filter((a) => agentEmphasis(a, filters) === 'dimmed').length, 2);
});

test('an unfiltered office dims nothing', () => {
  const model = withDepartments();
  for (const agent of model.agents) {
    assert.equal(agentEmphasis(agent, NO_FILTERS), 'focused');
  }
});

test('a project filter scopes by project without touching the room', () => {
  const model = withDepartments();
  const filters: OfficeFilters = { department: 'all', projectId: PROJECT_OMNI.projectId };
  const scoped = model.agents.filter((agent) => agentInScope(agent, filters));
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0].projectName, 'Omnisurge');
});

test('department and project filters combine', () => {
  const model = withDepartments();
  const filters: OfficeFilters = { department: 'development', projectId: PROJECT_OMNI.projectId };
  assert.equal(model.agents.filter((a) => agentEmphasis(a, filters) === 'focused').length, 0);
});

test('the project selector offers only projects on the floor, sorted', () => {
  const model = withDepartments();
  assert.deepEqual(projectsOnFloor(model.agents), [
    { id: PROJECT_MAHA.projectId, name: 'MAHA' },
    { id: PROJECT_OMNI.projectId, name: 'Omnisurge' },
  ]);
});

test('the activity feed is filtered by project only', () => {
  const model = buildOfficeModel({
    board: board([]),
    attention: [],
    queue: queue(),
    live,
    activity: [
      { projectId: PROJECT_MAHA.projectId },
      { projectId: PROJECT_OMNI.projectId },
    ] as never,
  });
  assert.equal(activityInScope(model.activity, NO_FILTERS).length, 2);
  assert.equal(
    activityInScope(model.activity, { department: 'all', projectId: PROJECT_OMNI.projectId })
      .length,
    1,
  );
});

/* Mobile: an ordered list, not a squeezed floor. */

test('mobile puts approvals first and the queue last', () => {
  const order = mobileAgents(
    buildOfficeModel({
      board: board([
        card('queued'),
        card('implementing'),
        card('waiting_approval'),
        card('testing'),
      ]),
      attention: [],
      queue: queue(),
      live,
    }),
    NO_FILTERS,
  ).map((agent) => agent.status);
  assert.deepEqual(order, ['approval', 'waiting', 'running', 'queued']);
});

test('mobile respects the project filter', () => {
  const model = buildOfficeModel({
    board: board([card('implementing'), card('analyzing', PROJECT_OMNI)]),
    attention: [],
    queue: queue(),
    live,
  });
  assert.equal(mobileAgents(model, NO_FILTERS).length, 2);
  assert.equal(
    mobileAgents(model, { department: 'all', projectId: PROJECT_OMNI.projectId }).length,
    1,
  );
});

/* The wire payload is never a rendering input. */

test('an event carrying agent narration never reaches the office model', () => {
  const c = card('implementing');
  const wire = event(c.taskId, 'agent_activity', 'implementing');
  const model = buildOfficeModel({
    board: board([c]),
    attention: [],
    queue: queue(),
    live,
  });
  assert.equal(model.agents[0].currentActionIsReal, false, 'no narration is rendered');
  assert.equal(model.agents[0].currentAction.includes(wire.message), false);
});
