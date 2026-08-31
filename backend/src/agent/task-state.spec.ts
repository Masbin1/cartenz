import {
  AGENT_TASK_STATUSES,
  IllegalTaskTransitionError,
  assertTransition,
  canTransition,
  isSuspendedStatus,
  isTerminalStatus,
  permittedTransitionsFrom,
  type AgentTaskStatus,
} from './task-state';

/**
 * The state machine is the single definition of how a task may move, so these
 * tests assert its properties rather than a list of examples: a new state added
 * without a route in or out fails here.
 */
describe('agent task state machine', () => {
  it('declares the thirteen states of ADR-018', () => {
    expect(AGENT_TASK_STATUSES).toHaveLength(13);
    for (const documented of [
      'created',
      'queued',
      'analyzing',
      'planning',
      'waiting_approval',
      'implementing',
      'testing',
      'completed',
      'failed',
      'cancelled',
    ]) {
      expect(AGENT_TASK_STATUSES).toContain(documented as AgentTaskStatus);
    }
    for (const added of ['committing', 'pushing', 'building']) {
      expect(AGENT_TASK_STATUSES).toContain(added as AgentTaskStatus);
    }
  });

  it('permits the documented happy path from creation to completion', () => {
    const path: AgentTaskStatus[] = [
      'created',
      'queued',
      'analyzing',
      'planning',
      'waiting_approval',
      'implementing',
      'testing',
      'committing',
      'waiting_approval',
      'pushing',
      'completed',
    ];

    for (let index = 0; index < path.length - 1; index += 1) {
      expect(canTransition(path[index], path[index + 1])).toBe(true);
    }
  });

  it('leaves every terminal state with no exit', () => {
    for (const status of AGENT_TASK_STATUSES) {
      if (isTerminalStatus(status)) {
        expect(permittedTransitionsFrom(status)).toHaveLength(0);
      }
    }
  });

  it('allows every non-terminal state to fail and to be cancelled', () => {
    for (const status of AGENT_TASK_STATUSES) {
      if (isTerminalStatus(status)) continue;
      expect(canTransition(status, 'failed')).toBe(true);
      expect(canTransition(status, 'cancelled')).toBe(true);
    }
  });

  it('makes every state reachable from created', () => {
    const reached = new Set<AgentTaskStatus>(['created']);
    let grew = true;

    while (grew) {
      grew = false;
      for (const status of [...reached]) {
        for (const next of permittedTransitionsFrom(status)) {
          if (!reached.has(next)) {
            reached.add(next);
            grew = true;
          }
        }
      }
    }

    expect([...reached].sort()).toEqual([...AGENT_TASK_STATUSES].sort());
  });

  it('refuses a transition that skips the approval gate', () => {
    expect(canTransition('planning', 'implementing')).toBe(false);
    expect(() => assertTransition('planning', 'implementing', 'task_1')).toThrow(
      IllegalTaskTransitionError,
    );
  });

  it('refuses to rewrite a terminal task', () => {
    expect(() => assertTransition('completed', 'implementing')).toThrow(
      IllegalTaskTransitionError,
    );
    expect(() => assertTransition('cancelled', 'queued')).toThrow(IllegalTaskTransitionError);
  });

  it('names both states and the task in the error, for the audit record', () => {
    try {
      assertTransition('completed', 'queued', 'task_9281');
      fail('the transition should have been refused');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('completed');
      expect(message).toContain('queued');
      expect(message).toContain('task_9281');
    }
  });

  it('treats only waiting_approval as suspended', () => {
    expect(isSuspendedStatus('waiting_approval')).toBe(true);
    for (const status of AGENT_TASK_STATUSES) {
      if (status !== 'waiting_approval') {
        expect(isSuspendedStatus(status)).toBe(false);
      }
    }
  });

  it('provides both return edges out of waiting_approval', () => {
    // Two gates suspend into this state; both must be able to resume.
    expect(canTransition('waiting_approval', 'implementing')).toBe(true);
    expect(canTransition('waiting_approval', 'pushing')).toBe(true);
  });
});
