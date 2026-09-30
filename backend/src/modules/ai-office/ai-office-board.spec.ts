import {
  describeAction,
  isLiveStatus,
  needsAttention,
  phaseFor,
  progressFor,
} from './ai-office-board';

/**
 * The board's own decisions (PRD docs/AI-OFFICE-PRD-draft.md): which column a
 * status belongs to, how far along it is, and what a card's action line says.
 * No database here on purpose - these are pure functions and the risk is in
 * the mapping table, not in any I/O.
 */
describe('phaseFor', () => {
  it('groups the pre-implementation states as research', () => {
    for (const status of [
      'created',
      'queued',
      'analyzing',
      'planning',
      'waiting_approval',
    ] as const) {
      expect(phaseFor(status)).toBe('research');
    }
  });

  it('maps implementing to development and testing to quality', () => {
    expect(phaseFor('implementing')).toBe('development');
    expect(phaseFor('testing')).toBe('quality');
  });

  it('groups commit, push, build and every terminal state as operations', () => {
    for (const status of [
      'committing',
      'pushing',
      'building',
      'completed',
      'failed',
      'cancelled',
    ] as const) {
      expect(phaseFor(status)).toBe('operations');
    }
  });
});

describe('progressFor', () => {
  it('is 0 at created and 1 at every terminal state', () => {
    expect(progressFor('created')).toBe(0);
    expect(progressFor('completed')).toBe(1);
    expect(progressFor('failed')).toBe(1);
    expect(progressFor('cancelled')).toBe(1);
  });

  it('increases monotonically through the happy path', () => {
    const path = [
      'created',
      'queued',
      'analyzing',
      'planning',
      'implementing',
      'testing',
      'committing',
      'pushing',
      'building',
      'completed',
    ] as const;
    const values = path.map(progressFor);
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i]).toBeGreaterThan(values[i - 1]);
    }
  });
});

describe('isLiveStatus / needsAttention', () => {
  it('excludes only the three terminal states from live', () => {
    expect(isLiveStatus('implementing')).toBe(true);
    expect(isLiveStatus('waiting_approval')).toBe(true);
    expect(isLiveStatus('completed')).toBe(false);
    expect(isLiveStatus('failed')).toBe(false);
    expect(isLiveStatus('cancelled')).toBe(false);
  });

  it('flags only waiting_approval as needing a human', () => {
    expect(needsAttention('waiting_approval')).toBe(true);
    expect(needsAttention('implementing')).toBe(false);
    expect(needsAttention('completed')).toBe(false);
  });
});

describe('describeAction', () => {
  it('returns null with no action recorded', () => {
    expect(describeAction(null)).toBeNull();
  });

  it('never surfaces a reasoning row', () => {
    expect(
      describeAction({
        actionType: 'reasoning',
        toolName: null,
        status: 'succeeded',
        path: null,
        transitionTo: null,
      }),
    ).toBeNull();
  });

  it('names the tool for a running tool call', () => {
    expect(
      describeAction({
        actionType: 'tool',
        toolName: 'list_modules',
        status: 'succeeded',
        path: null,
        transitionTo: null,
      }),
    ).toBe('Ran list_modules');
  });

  it('includes the path for a file tool', () => {
    expect(
      describeAction({
        actionType: 'tool',
        toolName: 'edit_file',
        status: 'succeeded',
        path: 'sale_priority/models/sale_order.py',
        transitionTo: null,
      }),
    ).toBe('Editing sale_priority/models/sale_order.py');
  });

  it('reports a denied tool distinctly from a failed one', () => {
    expect(
      describeAction({
        actionType: 'tool',
        toolName: 'git_push',
        status: 'denied',
        path: null,
        transitionTo: null,
      }),
    ).toBe('git_push was refused by policy');
    expect(
      describeAction({
        actionType: 'tool',
        toolName: 'run_odoo_test',
        status: 'failed',
        path: null,
        transitionTo: null,
      }),
    ).toBe('run_odoo_test failed');
  });

  it('describes a transition by its destination state', () => {
    expect(
      describeAction({
        actionType: 'transition',
        toolName: null,
        status: 'succeeded',
        path: null,
        transitionTo: 'waiting_approval',
      }),
    ).toBe('Moved to waiting approval');
  });
});
