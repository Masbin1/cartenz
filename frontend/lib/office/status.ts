import type { AgentTaskStatus, AiOfficePhase } from '@/lib/types';

/**
 * The office's own vocabulary for a task's state.
 *
 * This is a deliberate restatement of the backend's task state machine
 * (`backend/src/modules/ai-office/ai-office-board.ts`), not a second source of
 * truth: the board endpoint already returns `phase`, and this module exists
 * because the office also needs the status of the *previous* step to know which
 * room a task travelled from. If the backend state machine gains a status, the
 * mapping below must gain it too - TypeScript enforces that on the record, and
 * `status.test.ts` asserts the phase table against the backend's.
 */
export const OFFICE_STATUSES = [
  'running',
  'waiting',
  'approval',
  'queued',
  'completed',
  'failed',
  'cancelled',
  'idle',
] as const;

export type OfficeStatus = (typeof OFFICE_STATUSES)[number];

/**
 * Task status -> office status.
 *
 * `testing` reads as waiting rather than running on purpose. It is the longest
 * quiet stretch of a task: the worker has handed off to a test run and the task
 * row does not change until it comes back, so a "typing" animation would be a
 * lie about what is happening.
 */
const STATUS_BY_TASK: Readonly<Record<AgentTaskStatus, OfficeStatus>> = {
  created: 'queued',
  queued: 'queued',
  analyzing: 'running',
  planning: 'running',
  implementing: 'running',
  committing: 'running',
  pushing: 'running',
  building: 'running',
  testing: 'waiting',
  waiting_approval: 'approval',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
};

export function officeStatusFor(status: AgentTaskStatus): OfficeStatus {
  return STATUS_BY_TASK[status];
}

export const STATUS_LABELS: Readonly<Record<OfficeStatus, string>> = {
  running: 'Working',
  waiting: 'Waiting',
  approval: 'Approval',
  queued: 'Queued',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  idle: 'Idle',
};

/**
 * One glyph per status. Colour is never the only signal, and the legend, the
 * desk chip and the standing figures all read these, so they cannot drift.
 */
export const STATUS_GLYPHS: Readonly<Record<OfficeStatus, string>> = {
  running: '●',
  waiting: '◐',
  approval: '⚠',
  queued: '○',
  completed: '✓',
  failed: '×',
  cancelled: '×',
  idle: '◌',
};

/** The default line under an agent's name when no recorded action beats it. */
export const STATUS_ACTIONS: Readonly<Record<OfficeStatus, string>> = {
  running: 'Working on it',
  waiting: 'Waiting on a long step',
  approval: 'Paused for your approval',
  queued: 'Waiting for a free worker',
  completed: 'Finished',
  failed: 'Stopped with an error',
  cancelled: 'Cancelled',
  idle: 'No task',
};

/**
 * Task status -> room, mirroring the backend's `phaseFor`. The authoritative
 * value for a live card arrives on the card itself; this table is used for the
 * step *before* it, which the API does not report.
 */
const PHASE_BY_TASK: Readonly<Record<AgentTaskStatus, AiOfficePhase>> = {
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

export function phaseFor(status: AgentTaskStatus): AiOfficePhase {
  return PHASE_BY_TASK[status];
}

/**
 * The state machine in order, used only to find a task's previous room.
 *
 * `created` and `queued` are absent on purpose: they are pre-flight states, so a
 * queued task has not been in any room yet and must not be drawn walking out of
 * one. `analyzing` is the first state that happens inside a room, so it is the
 * head of the walk.
 */
const TASK_ORDER: readonly AgentTaskStatus[] = [
  'analyzing',
  'planning',
  'waiting_approval',
  'implementing',
  'testing',
  'committing',
  'pushing',
  'building',
  'completed',
];

/** The room a task occupied immediately before its current status, if any. */
export function previousPhase(status: AgentTaskStatus): AiOfficePhase | null {
  const index = TASK_ORDER.indexOf(status);
  if (index <= 0) return null;
  return PHASE_BY_TASK[TASK_ORDER[index - 1]];
}

/** A status that still occupies a desk. The board endpoint filters these. */
export function isOfficeLive(status: OfficeStatus): boolean {
  return status !== 'completed' && status !== 'failed' && status !== 'cancelled';
}

/** A status that wants a human. */
export function needsAttention(status: OfficeStatus): boolean {
  return status === 'approval';
}
