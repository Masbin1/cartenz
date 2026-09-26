import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentTaskStatus } from '@/lib/types';
import {
  OFFICE_STATUSES,
  isOfficeLive,
  needsAttention,
  officeStatusFor,
  phaseFor,
  previousPhase,
} from './status';

/**
 * The backend's own phase table (ai-office-board.ts PHASE_BY_STATUS), copied
 * here so a change to either side breaks this test rather than silently
 * drifting. If the backend's mapping changes, update both.
 */
const BACKEND_PHASE_BY_STATUS: Record<AgentTaskStatus, string> = {
  created: 'research',
  queued: 'research',
  analyzing: 'research',
  planning: 'research',
  waiting_approval: 'research',
  implementing: 'development',
  testing: 'quality',
  committing: 'operations',
  pushing: 'operations',
  building: 'operations',
  completed: 'operations',
  failed: 'operations',
  cancelled: 'operations',
};

test('phaseFor matches the backend phase table for every status', () => {
  for (const [status, phase] of Object.entries(BACKEND_PHASE_BY_STATUS)) {
    assert.equal(phaseFor(status as AgentTaskStatus), phase, status);
  }
});

test('officeStatusFor covers every AgentTaskStatus with no gaps', () => {
  const statuses: AgentTaskStatus[] = [
    'created',
    'queued',
    'analyzing',
    'planning',
    'waiting_approval',
    'implementing',
    'testing',
    'committing',
    'pushing',
    'building',
    'completed',
    'failed',
    'cancelled',
  ];
  for (const status of statuses) {
    const office = officeStatusFor(status);
    assert.ok(OFFICE_STATUSES.includes(office), `${status} -> ${office}`);
  }
});

test('testing reads as waiting, not running: nothing is typed during a test run', () => {
  assert.equal(officeStatusFor('testing'), 'waiting');
});

test('waiting_approval reads as approval', () => {
  assert.equal(officeStatusFor('waiting_approval'), 'approval');
});

test('isOfficeLive is false only for the three terminal statuses', () => {
  assert.equal(isOfficeLive('completed'), false);
  assert.equal(isOfficeLive('failed'), false);
  assert.equal(isOfficeLive('cancelled'), false);
  assert.equal(isOfficeLive('running'), true);
  assert.equal(isOfficeLive('waiting'), true);
  assert.equal(isOfficeLive('approval'), true);
  assert.equal(isOfficeLive('queued'), true);
  assert.equal(isOfficeLive('idle'), true);
});

test('needsAttention is true only for approval', () => {
  assert.equal(needsAttention('approval'), true);
  for (const status of OFFICE_STATUSES) {
    if (status !== 'approval') assert.equal(needsAttention(status), false, status);
  }
});

test('previousPhase: created and queued have no previous room', () => {
  assert.equal(previousPhase('created'), null);
  assert.equal(previousPhase('queued'), null);
});

test('previousPhase: a task in development came from research', () => {
  assert.equal(previousPhase('implementing'), 'research');
});

test('previousPhase: a task in quality came from development', () => {
  assert.equal(previousPhase('testing'), 'development');
});

test('previousPhase: a task in operations came from quality once, not on every operations step', () => {
  assert.equal(previousPhase('committing'), 'quality');
  assert.equal(previousPhase('pushing'), 'operations');
  assert.equal(previousPhase('building'), 'operations');
});

test('previousPhase: failed/cancelled are not in the walk order and have no previous room', () => {
  assert.equal(previousPhase('failed'), null);
  assert.equal(previousPhase('cancelled'), null);
});
