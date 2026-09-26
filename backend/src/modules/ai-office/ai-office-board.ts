import { AGENT_TASK_STATUSES, type AgentTaskStatus } from '../../agent/task-state';

/**
 * The AI Office board (PRD docs/AI-OFFICE-PRD-draft.md).
 *
 * Pure helpers, extracted for the same reason `preview-plan.ts` is separate from
 * its service: the decisions the board makes - which phase a task belongs to,
 * how far along it is, how the columns are ordered - are the part most likely to
 * be quietly wrong, and they can be asserted without a database or a running
 * worker.
 */

/**
 * The columns of the board.
 *
 * These are the task's own lifecycle phases, not invented departments: a task in
 * `implementing` is in development, one in `testing` is in quality assurance.
 * Naming them as departments would suggest specialist agents that do not exist
 * (PRD §2); naming them after the phases keeps every card traceable to a state
 * the rest of the portal already shows.
 */
export const BOARD_PHASES = ['research', 'development', 'quality', 'operations'] as const;
export type BoardPhase = (typeof BOARD_PHASES)[number];

export const PHASE_LABELS: Readonly<Record<BoardPhase, string>> = {
  research: 'Research',
  development: 'Development',
  quality: 'Quality',
  operations: 'Operations',
};

/**
 * Which phase each task state belongs to.
 *
 * `waiting_approval` is deliberately not a column: a task waiting on a person is
 * not progressing, and the board surfaces those in a separate "needs you" queue
 * where they cannot be mistaken for work in flight. It still has a phase here so
 * a waiting card keeps its place rather than disappearing.
 */
const PHASE_BY_STATUS: Readonly<Record<AgentTaskStatus, BoardPhase>> = {
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

export function phaseFor(status: AgentTaskStatus): BoardPhase {
  return PHASE_BY_STATUS[status];
}

/**
 * How far through its lifecycle a task is, as a fraction.
 *
 * Derived from the task's position in the state machine, never from a timer: a
 * bar that advances because time passed would be the fake progress the PRD
 * forbids (§7, §10). Terminal states are exactly 1; `created` is 0.
 */
export function progressFor(status: AgentTaskStatus): number {
  if (!isLiveStatus(status)) return 1;
  // Measured along the happy path only: `AGENT_TASK_STATUSES` also lists the
  // two non-success terminal states after `completed`, which would otherwise
  // leave a finished task short of the end of the bar.
  const index = HAPPY_PATH.indexOf(status);
  if (index < 0) return 0;
  return index / (HAPPY_PATH.length - 1);
}

const HAPPY_PATH: readonly AgentTaskStatus[] = AGENT_TASK_STATUSES.filter(
  (status) => status !== 'failed' && status !== 'cancelled',
);

/** A task is live while it occupies (or is queued for) a worker. */
export function isLiveStatus(status: AgentTaskStatus): boolean {
  return status !== 'completed' && status !== 'failed' && status !== 'cancelled';
}

/** Only a task parked on a human decision belongs in the needs-you queue. */
export function needsAttention(status: AgentTaskStatus): boolean {
  return status === 'waiting_approval';
}

/**
 * A one-line, human-readable description of what the task is doing, built from
 * the last action the agent actually recorded.
 *
 * Summaries only. `reasoning` rows carry the agent's own narration and are
 * never turned into a line (PRD §7: no chain-of-thought in the browser), and of
 * a tool call only its name and - for file tools - the file path are used. The
 * caller selects just those columns, so file contents, Odoo records and command
 * output never leave the database for this view.
 */
export interface ActionSummaryInput {
  readonly actionType: string;
  readonly toolName: string | null;
  readonly status: string;
  /** `input->>'path'` for file tools; null otherwise. */
  readonly path: string | null;
  /** `output->>'to'` for transitions; null otherwise. */
  readonly transitionTo: string | null;
}

const FILE_TOOLS: ReadonlySet<string> = new Set(['create_file', 'edit_file', 'read_file']);

export function describeAction(action: ActionSummaryInput | null): string | null {
  if (!action) return null;

  if (action.actionType === 'tool' && action.toolName) {
    const name = action.toolName;
    if (action.status === 'denied') return `${name} was refused by policy`;
    if (action.status === 'failed') return `${name} failed`;
    if (FILE_TOOLS.has(name) && action.path) {
      const verb = name === 'read_file' ? 'Reading' : 'Editing';
      return `${verb} ${action.path}`;
    }
    return `Ran ${name}`;
  }

  if (action.actionType === 'transition' && action.transitionTo) {
    return `Moved to ${action.transitionTo.replace(/_/g, ' ')}`;
  }

  if (action.actionType === 'approval') return 'Waiting for approval';

  return null;
}
