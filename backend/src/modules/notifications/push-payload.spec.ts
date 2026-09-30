import { buildPushPayload, isNotifyingEvent, taskPath } from './push-payload';

const PROJECT_ID = '11111111-1111-1111-1111-111111111111';
const TASK_ID = '22222222-2222-2222-2222-222222222222';

const base = {
  taskId: TASK_ID,
  taskReference: 'task_9281',
  projectId: PROJECT_ID,
  projectName: 'Harleys Fine Baking',
  portalUrl: 'https://cartenz.masbintang.space',
  soundEnabled: true,
};

describe('isNotifyingEvent', () => {
  it('accepts the three events a person is told about', () => {
    expect(isNotifyingEvent('approval_required')).toBe(true);
    expect(isNotifyingEvent('task_completed')).toBe(true);
    expect(isNotifyingEvent('task_failed')).toBe(true);
  });

  it('rejects the progress events nobody is interrupted for', () => {
    expect(isNotifyingEvent('agent_activity')).toBe(false);
    expect(isNotifyingEvent('tool_started')).toBe(false);
    expect(isNotifyingEvent('task_status_changed')).toBe(false);
  });
});

describe('buildPushPayload', () => {
  it('names the project and task an approval is waiting on', () => {
    const payload = buildPushPayload({ ...base, event: 'approval_required' });

    expect(payload.title).toBe('Approval needed');
    expect(payload.body).toContain('task_9281');
    expect(payload.body).toContain('Harleys Fine Baking');
    expect(payload.requireInteraction).toBe(true);
    expect(payload.sound).toBe('approval');
  });

  it('builds an absolute portal URL that opens the task', () => {
    const payload = buildPushPayload({ ...base, event: 'task_completed' });

    expect(payload.url).toBe(
      `https://cartenz.masbintang.space/projects/${PROJECT_ID}/agent?task=${TASK_ID}`,
    );
    expect(payload.sound).toBe('done');
    expect(payload.requireInteraction).toBe(false);
  });

  it('collapses repeats per task and kind', () => {
    const approval = buildPushPayload({ ...base, event: 'approval_required' });
    const completed = buildPushPayload({ ...base, event: 'task_completed' });

    // Two approvals for one task replace each other; an outcome does not
    // overwrite the approval that preceded it.
    expect(approval.tag).toBe(`task-${TASK_ID}-approval`);
    expect(completed.tag).toBe(`task-${TASK_ID}-outcome`);
  });

  it('omits the sound when the user turned sound off', () => {
    const payload = buildPushPayload({ ...base, event: 'task_failed', soundEnabled: false });

    expect(payload.sound).toBeNull();
    expect(payload.title).toBe('Task failed');
  });

  it('falls back to a relative URL when the portal origin is not configured', () => {
    const payload = buildPushPayload({ ...base, event: 'task_completed', portalUrl: null });

    expect(payload.url).toBe(taskPath(PROJECT_ID, TASK_ID));
  });

  it('truncates a long project name rather than sending an essay to a lock screen', () => {
    const payload = buildPushPayload({
      ...base,
      event: 'task_completed',
      projectName: 'A'.repeat(200),
    });

    expect(payload.body.length).toBeLessThan(200);
    expect(payload.body).toContain('…');
  });

  it('carries no task content, only the reference and the project', () => {
    const payload = buildPushPayload({
      ...base,
      event: 'approval_required',
      // Deliberately not passed in: the builder has no field for a prompt.
    }) as unknown as Record<string, unknown>;

    expect(Object.keys(payload).sort()).toEqual(
      [
        'body',
        'event',
        'projectId',
        'requireInteraction',
        'sound',
        'tag',
        'taskId',
        'title',
        'url',
      ].sort(),
    );
  });
});
