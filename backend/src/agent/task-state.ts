/**
 * The agent task state machine.
 *
 * This file is the single definition of what states a task may occupy and how it
 * may move between them. Nothing else in the codebase may write a task status.
 * Every write passes through assertTransition, so an illegal transition is a
 * thrown error at the point of the attempt rather than a corrupt row discovered
 * later.
 *
 * Source: chapter 6 of the Technical Architecture. The chapter states the
 * permitted states in prose (created, queued, analyzing, planning,
 * waiting_approval, implementing, testing, failed, cancelled, completed) but its
 * own state diagram, and the Git automation phase of the roadmap, additionally
 * require COMMITTING, PUSHING and BUILDING. Those three are included here: a
 * task that commits and pushes must be observably in those states, and omitting
 * them would force the lifecycle to misreport itself as `testing` while pushing.
 * This is recorded as ADR-018.
 *
 * ADR-029 amends one transition: a `chat` task branches at the point a `change`
 * task would plan, walking `analyzing -> implementing` directly. That edge is
 * added to the analyzing transitions below.
 */

export const AGENT_TASK_STATUSES = [
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
] as const;

export type AgentTaskStatus = (typeof AGENT_TASK_STATUSES)[number];

/**
 * Terminal states. A task in a terminal state is never rewritten; the record is
 * evidence and is retained as it stands.
 */
export const TERMINAL_TASK_STATUSES: readonly AgentTaskStatus[] = [
  'completed',
  'failed',
  'cancelled',
];

/**
 * States in which the platform holds no work and is waiting on a person. A task
 * here occupies no worker: the job has completed and the approval decision
 * enqueues a continuation (ADR-011).
 */
export const SUSPENDED_TASK_STATUSES: readonly AgentTaskStatus[] = ['waiting_approval'];

/**
 * Permitted transitions.
 *
 * `failed` is reachable from every non-terminal state because any step may
 * error. `cancelled` is reachable from every non-terminal state because a user
 * may withdraw a task at any point before it settles.
 */
const TRANSITIONS: Readonly<Record<AgentTaskStatus, readonly AgentTaskStatus[]>> = {
  created: ['queued', 'failed', 'cancelled'],
  queued: ['analyzing', 'failed', 'cancelled'],
  // analyzing -> implementing is the chat path (ADR-029): a conversational task
  // has no plan gate, so it goes straight from analysis to the model loop.
  analyzing: ['planning', 'implementing', 'failed', 'cancelled'],
  planning: ['waiting_approval', 'failed', 'cancelled'],
  // Two gates suspend into waiting_approval, so two edges lead back out: the
  // plan gate resumes into implementing, the push gate into pushing. Which one
  // applies is decided by the approval that was granted, not by this table.
  waiting_approval: ['implementing', 'pushing', 'failed', 'cancelled'],
  // A write approval during implementation (chat_edit for a chat task, or
  // file_deletion) suspends the task from implementing into waiting_approval,
  // then resumes back into implementing once decided (ADR-029). The edge is
  // absent from the chapter-6 diagram but required by the approval mechanism.
  //
  // ADR-053 adds implementing -> committing: an approved write in a chat task
  // goes straight to the commit/push machinery. A conversation has nothing to
  // validate, so it has no reason to pass through `testing` - that hop remains
  // only for a chat that answered and changed nothing.
  implementing: ['testing', 'committing', 'waiting_approval', 'failed', 'cancelled'],
  // Testing may return to implementing so that a failed validation can be
  // repaired within the same task rather than requiring a new one.
  testing: ['implementing', 'committing', 'completed', 'failed', 'cancelled'],
  // Committing requires a further approval before the push leaves the platform,
  // so waiting_approval is reachable from here. It also reaches completed
  // directly: when GIT_PUSH_ENABLED is false there is no push to approve, and
  // the commit in the workspace is the whole of the result (ADR-021 s1).
  committing: ['waiting_approval', 'pushing', 'completed', 'failed', 'cancelled'],
  /**
   * `pushing -> waiting_approval` is a backstop, and it has to exist.
   *
   * The push gate is normally satisfied before this state is entered: either a
   * person approved it (committing -> waiting_approval -> pushing) or the
   * deployment authorised it and recorded the grant (ADR-041). When neither had
   * happened, the tool gate refused the push *while the task was already in
   * `pushing`*, and the suspension it attempted was refused here - so the
   * approval row was written, the job died on a throw, and BullMQ retried the
   * whole step. The operator saw the same prompt twice or three times for one
   * push, and the retries are what made a single authorisation look like two.
   *
   * A state machine whose refusal kills the run must not be the reason a
   * legitimate suspension cannot happen. Refusing the edge never prevented the
   * suspension; it only made it fatal, and hid the disagreement between the
   * workflow and the gate behind a crash.
   */
  pushing: ['building', 'waiting_approval', 'completed', 'failed', 'cancelled'],
  building: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

export function isTerminalStatus(status: AgentTaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.includes(status);
}

export function isSuspendedStatus(status: AgentTaskStatus): boolean {
  return SUSPENDED_TASK_STATUSES.includes(status);
}

export function permittedTransitionsFrom(status: AgentTaskStatus): readonly AgentTaskStatus[] {
  return TRANSITIONS[status];
}

export function canTransition(from: AgentTaskStatus, to: AgentTaskStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * Raised when a transition is refused. Carries both states so that the audit
 * record of the failure is self-describing.
 */
export class IllegalTaskTransitionError extends Error {
  constructor(
    readonly from: AgentTaskStatus,
    readonly to: AgentTaskStatus,
    readonly taskId?: string,
  ) {
    super(
      `Illegal agent task transition ${from} -> ${to}` +
        (taskId ? ` for task ${taskId}` : '') +
        `. Permitted from ${from}: ${permittedTransitionsFrom(from).join(', ') || '(none, terminal)'}`,
    );
    this.name = 'IllegalTaskTransitionError';
  }
}

export function assertTransition(
  from: AgentTaskStatus,
  to: AgentTaskStatus,
  taskId?: string,
): void {
  if (!canTransition(from, to)) {
    throw new IllegalTaskTransitionError(from, to, taskId);
  }
}

/**
 * Human-readable label for each state, used by the API and the portal so that
 * the wording of a status appears once rather than in every component.
 */
export const TASK_STATUS_LABELS: Readonly<Record<AgentTaskStatus, string>> = {
  created: 'Created',
  queued: 'Queued',
  analyzing: 'Analysing project',
  planning: 'Creating plan',
  waiting_approval: 'Awaiting approval',
  implementing: 'Implementing',
  testing: 'Validating',
  committing: 'Committing',
  pushing: 'Pushing',
  building: 'Building',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};
