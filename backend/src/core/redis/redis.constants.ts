/**
 * Redis and queue naming. Held in one file so that a channel or queue name is
 * never spelled out at a call site, where a typo would silently create a second
 * channel that nothing subscribes to.
 */

/** BullMQ queue carrying agent task execution jobs. */
export const AGENT_TASK_QUEUE = 'agent-tasks';

/** Job names on the agent task queue. */
export const AGENT_JOB_EXECUTE = 'execute-task';
export const AGENT_JOB_RESUME = 'resume-task';

/**
 * Pub/sub channel for a single task's event stream, in the form documented in
 * chapter 9: task:{task_id}:events.
 */
export function taskEventChannel(taskId: string): string {
  return `task:${taskId}:events`;
}

/**
 * Pattern subscribed to by the WebSocket gateway. One pattern subscription
 * serves every connected client, rather than one subscription per task.
 */
export const TASK_EVENT_CHANNEL_PATTERN = 'task:*:events';

/** Extracts the task id from a channel name produced by taskEventChannel. */
export function taskIdFromChannel(channel: string): string | null {
  const match = /^task:(.+):events$/.exec(channel);
  return match ? match[1] : null;
}
