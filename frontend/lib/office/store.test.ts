import test from 'node:test';
import assert from 'node:assert/strict';
import { INITIAL_OFFICE_STATE, officeReducer, type OfficeState } from './store';
import { board, card, event, queue } from './fixtures';

const snapshot = (
  state: OfficeState,
  override: Partial<Parameters<typeof officeReducer>[1]> = {},
) =>
  officeReducer(state, {
    kind: 'snapshot',
    board: board([]),
    attention: [],
    queue: queue(),
    activity: [],
    activityPage: 40,
    at: new Date('2026-09-26T02:00:00.000Z'),
    ...override,
  } as never);

test('starts connecting, with nothing loaded', () => {
  assert.equal(INITIAL_OFFICE_STATE.connection, 'connecting');
  assert.equal(INITIAL_OFFICE_STATE.board, null);
});

test('a snapshot replaces the board and clears moved marks', () => {
  const c = card('implementing');
  const withMove = officeReducer(INITIAL_OFFICE_STATE, {
    kind: 'event',
    event: event(c.taskId, 'task_status_changed', 'implementing'),
  });
  const after = snapshot(withMove, { board: board([c]) });
  assert.equal(after.board?.cards.length, 1);
  assert.equal(after.movedTaskIds.size, 0);
  assert.equal(after.needsResync, false);
});

test('a snapshot failure keeps the last known floor and only records the error', () => {
  const c = card('implementing');
  const loaded = snapshot(INITIAL_OFFICE_STATE, { board: board([c]) });
  const failed = officeReducer(loaded, { kind: 'snapshot-failed', error: 'network down' });
  assert.equal(failed.board?.cards.length, 1);
  assert.equal(failed.error, 'network down');
});

test('the first socket-open makes the office live', () => {
  const opened = officeReducer(INITIAL_OFFICE_STATE, { kind: 'socket-open' });
  assert.equal(opened.connection, 'live');
  assert.equal(opened.needsResync, false);
});

test('a reconnect goes through synchronizing, not straight to live', () => {
  const live = officeReducer(INITIAL_OFFICE_STATE, { kind: 'socket-open' });
  const dropped = officeReducer(live, { kind: 'socket-closed' });
  assert.equal(dropped.connection, 'reconnecting');
  const reopened = officeReducer(dropped, { kind: 'socket-open' });
  assert.equal(reopened.connection, 'synchronizing');
  assert.equal(reopened.needsResync, true);
});

test('a snapshot while synchronizing brings the office back to live', () => {
  const live = officeReducer(INITIAL_OFFICE_STATE, { kind: 'socket-open' });
  const dropped = officeReducer(live, { kind: 'socket-closed' });
  const reopened = officeReducer(dropped, { kind: 'socket-open' });
  const resynced = snapshot(reopened);
  assert.equal(resynced.connection, 'live');
});

test('agent.started (task_status_changed to analyzing) moves the card and asks for a resync', () => {
  const c = card('queued');
  const loaded = snapshot(INITIAL_OFFICE_STATE, { board: board([c]) });
  const started = officeReducer(loaded, {
    kind: 'event',
    event: event(c.taskId, 'task_status_changed', 'analyzing'),
  });
  assert.equal(started.board?.cards[0].status, 'analyzing');
  assert.equal(started.board?.cards[0].phase, 'research');
  assert.equal(started.movedTaskIds.has(c.taskId), true);
  assert.equal(started.needsResync, true);
});

test('agent.progress-shaped events (tool_started) do not change status but still ask for a resync', () => {
  const c = card('implementing');
  const loaded = snapshot(INITIAL_OFFICE_STATE, { board: board([c]) });
  const progressed = officeReducer(loaded, {
    kind: 'event',
    event: event(c.taskId, 'tool_started', 'implementing'),
  });
  assert.equal(progressed.board?.cards[0].status, 'implementing');
  assert.equal(progressed.movedTaskIds.has(c.taskId), false, 'no status change, no walk');
  assert.equal(progressed.needsResync, true);
});

test('agent.completed removes the card from the floor without inventing a recent entry', () => {
  const c = card('building');
  const loaded = snapshot(INITIAL_OFFICE_STATE, { board: board([c]) });
  const completed = officeReducer(loaded, {
    kind: 'event',
    event: event(c.taskId, 'task_completed', 'completed'),
  });
  assert.equal(completed.board?.cards.length, 0);
  assert.equal(
    completed.board?.recent.length,
    0,
    'recent needs endedAt from the resync, not a guess',
  );
  assert.equal(
    completed.movedTaskIds.has(c.taskId),
    false,
    'a terminal status does not walk to a desk',
  );
});

test('agent.failed removes the card the same way as completed', () => {
  const c = card('testing');
  const loaded = snapshot(INITIAL_OFFICE_STATE, { board: board([c]) });
  const failed = officeReducer(loaded, {
    kind: 'event',
    event: event(c.taskId, 'task_failed', 'failed'),
  });
  assert.equal(failed.board?.cards.length, 0);
});

test('approval.required (waiting_approval) moves the card without removing it', () => {
  const c = card('implementing');
  const loaded = snapshot(INITIAL_OFFICE_STATE, { board: board([c]) });
  const waiting = officeReducer(loaded, {
    kind: 'event',
    event: event(c.taskId, 'approval_required', 'waiting_approval'),
  });
  assert.equal(waiting.board?.cards[0].status, 'waiting_approval');
  assert.equal(waiting.board?.cards.length, 1);
});

test('an event for a task not on the floor moves nothing but still asks for a resync', () => {
  const loaded = snapshot(INITIAL_OFFICE_STATE, { board: board([]) });
  const after = officeReducer(loaded, {
    kind: 'event',
    event: event('unknown-task', 'task_started', 'analyzing'),
  });
  assert.equal(after.board?.cards.length, 0);
  assert.equal(after.needsResync, true);
});

test('an event before any snapshot only asks for a resync', () => {
  const after = officeReducer(INITIAL_OFFICE_STATE, {
    kind: 'event',
    event: event('task-x', 'task_started', 'analyzing'),
  });
  assert.equal(after.board, null);
  assert.equal(after.needsResync, true);
});

test('an out-of-order (stale) event is dropped', () => {
  const c = card('implementing');
  const loaded = snapshot(INITIAL_OFFICE_STATE, { board: board([c]) });
  const later = officeReducer(loaded, {
    kind: 'event',
    event: event(c.taskId, 'task_status_changed', 'testing', { sequence: 10 }),
  });
  const stale = officeReducer(later, {
    kind: 'event',
    event: event(c.taskId, 'task_status_changed', 'implementing', { sequence: 5 }),
  });
  assert.equal(
    stale.board?.cards[0].status,
    'testing',
    'the earlier-sequence event must not roll the status back',
  );
});

test('a duplicate event (same sequence) is dropped', () => {
  const c = card('implementing');
  const loaded = snapshot(INITIAL_OFFICE_STATE, { board: board([c]) });
  const moved = officeReducer(loaded, {
    kind: 'event',
    event: event(c.taskId, 'task_status_changed', 'testing', { sequence: 3 }),
  });
  const resynced = { ...moved, movedTaskIds: new Set<string>() };
  const repeated = officeReducer(resynced, {
    kind: 'event',
    event: event(c.taskId, 'task_status_changed', 'implementing', { sequence: 3 }),
  });
  assert.equal(repeated.movedTaskIds.size, 0, 'the same sequence must not move the card again');
});

test('an event never stores the narration message', () => {
  const c = card('implementing');
  const loaded = snapshot(INITIAL_OFFICE_STATE, { board: board([c]) });
  const wire = event(c.taskId, 'agent_activity', 'implementing', {
    message: 'I will now inspect the sales order model before editing it',
  });
  const after = officeReducer(loaded, { kind: 'event', event: wire });
  const serialised = JSON.stringify(after);
  assert.equal(serialised.includes('inspect the sales order model'), false);
});

test('loading more activity appends without duplicating', () => {
  const first = { id: 'a1', at: '2026-09-26T01:00:00.000Z' };
  const older = { id: 'a2', at: '2026-09-26T00:00:00.000Z' };
  const loaded = snapshot(INITIAL_OFFICE_STATE, {
    activity: [first] as never,
    activityPage: 40,
  });
  const appended = officeReducer(loaded, {
    kind: 'older-activity',
    items: [first, older] as never,
    activityPage: 40,
  });
  assert.deepEqual(
    appended.activity.map((item) => item.id),
    ['a1', 'a2'],
  );
  assert.equal(appended.hasMoreActivity, false, 'fewer than a full page means no more to load');
});

test('a card not touched by an event keeps referential identity', () => {
  const untouched = card('implementing');
  const touched = card('implementing');
  const loaded = snapshot(INITIAL_OFFICE_STATE, { board: board([untouched, touched]) });
  const after = officeReducer(loaded, {
    kind: 'event',
    event: event(touched.taskId, 'task_status_changed', 'testing'),
  });
  const untouchedAfter = after.board?.cards.find((c) => c.taskId === untouched.taskId);
  assert.equal(
    untouchedAfter,
    loaded.board?.cards.find((c) => c.taskId === untouched.taskId),
  );
});
