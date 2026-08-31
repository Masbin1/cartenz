import type { AgentTaskStatus } from '../../agent/task-state';

/**
 * Realtime event types. Chapter 15 of the architecture enumerates these; the
 * list is closed so that the portal can exhaustively handle it and a new event
 * cannot be introduced without the front end being updated.
 */
export const TASK_EVENT_TYPES = [
  'task_started',
  'agent_activity',
  'tool_started',
  'tool_completed',
  'file_modified',
  'approval_required',
  'test_started',
  'test_completed',
  'task_completed',
  'task_failed',
  // Emitted on every status change so the portal never has to infer the state
  // machine from the other event types.
  'task_status_changed',
] as const;

export type TaskEventType = (typeof TASK_EVENT_TYPES)[number];

export const TASK_EVENT_STATUSES = ['pending', 'running', 'succeeded', 'failed'] as const;
export type TaskEventStatus = (typeof TASK_EVENT_STATUSES)[number];

/**
 * The wire format documented in chapter 15, with three additions: `sequence`,
 * so a client can detect a gap and re-fetch; `taskStatus`, so every event
 * carries the current lifecycle state; and `at`, so the client renders the
 * server's clock rather than its own.
 */
export interface TaskEvent {
  readonly taskId: string;
  readonly taskReference: string;
  readonly sequence: number;
  readonly type: TaskEventType;
  readonly status: TaskEventStatus;
  readonly taskStatus: AgentTaskStatus;
  readonly message: string;
  readonly at: string;
  /**
   * Event-specific detail. Passed through the audit redaction filter before
   * publication, so a tool result cannot leak a credential to a browser.
   */
  readonly payload?: Record<string, unknown>;
}
