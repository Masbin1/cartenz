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
 * ADR-056. A selective module install runs `odoo-bin -i <modules>` on the
 * host, which can take minutes — long enough that it must not run on an HTTP
 * request thread (PROCESS_MAX_TIMEOUT_MS is a hard 5-minute ceiling on the
 * platform's own process runner, not a request deadline this queue is
 * bypassing). A dedicated queue rather than a new job name on
 * `AGENT_TASK_QUEUE`: this work has nothing to do with agent task execution,
 * shares no payload shape with it, and giving it its own queue means the
 * agent worker's concurrency setting cannot accidentally throttle project
 * provisioning or vice versa.
 */
export const PROJECT_PROVISIONING_QUEUE = 'project-provisioning';
export const PROJECT_PROVISIONING_JOB = 'provision-modules';

/**
 * ADR-057: restarting a project's instance after a merge.
 *
 * A restart runs `odoo-bin -u all` against the instance's own database before
 * bouncing its unit, which is the same order of magnitude of work as a
 * selective install and for the same reason must not run on an HTTP request
 * thread. It shares `PROJECT_PROVISIONING_QUEUE` rather than getting a queue of
 * its own: it is the same class of host action, on the same projects, with the
 * same "one at a time, the host is busy" property — a second queue would only
 * let a restart and a provisioning run fight over the same CPU.
 */
export const PROJECT_RESTART_JOB = 'restart-project';

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
