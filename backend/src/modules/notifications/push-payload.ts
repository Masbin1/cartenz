import type { TaskEventType } from '../../core/events/event-types';

/**
 * The three task events that notify a person (ADR-065). Everything else the
 * agent emits is progress for whoever is watching the task, not a reason to
 * interrupt someone who is not.
 */
export const NOTIFYING_EVENTS = ['approval_required', 'task_completed', 'task_failed'] as const;
export type NotifyingEvent = (typeof NOTIFYING_EVENTS)[number];

export function isNotifyingEvent(type: TaskEventType): type is NotifyingEvent {
  return (NOTIFYING_EVENTS as readonly string[]).includes(type);
}

/** Which sound the portal plays, by name. The browser maps it to a file. */
export type NotificationSound = 'approval' | 'done' | 'failed';

/**
 * The payload a browser's service worker receives. Deliberately small and
 * deliberately free of content: no prompt, no diff, no tool output, no Odoo
 * record. A push message transits a third-party push service (Google, Mozilla,
 * Apple) and sits on the device's lock screen, so it carries only what is
 * needed to say "this task needs you" and to open it.
 */
export interface PushPayload {
  readonly title: string;
  readonly body: string;
  /** Collapses repeats: a second push with the same tag replaces the first. */
  readonly tag: string;
  /** Absolute URL of the task in the portal. */
  readonly url: string;
  readonly sound: NotificationSound | null;
  readonly event: NotifyingEvent;
  readonly taskId: string;
  readonly projectId: string;
  /** Keep the notification up until the person acts. Only for approvals. */
  readonly requireInteraction: boolean;
}

export interface PushPayloadInput {
  readonly event: NotifyingEvent;
  readonly taskId: string;
  readonly taskReference: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly portalUrl: string | null;
  readonly soundEnabled: boolean;
}

const TITLES: Record<NotifyingEvent, string> = {
  approval_required: 'Approval needed',
  task_completed: 'Task completed',
  task_failed: 'Task failed',
};

const BODIES: Record<NotifyingEvent, (reference: string, project: string) => string> = {
  approval_required: (reference, project) => `${reference} in ${project} is waiting for your approval.`,
  task_completed: (reference, project) => `${reference} in ${project} has finished.`,
  task_failed: (reference, project) => `${reference} in ${project} stopped with an error.`,
};

const SOUNDS: Record<NotifyingEvent, NotificationSound> = {
  approval_required: 'approval',
  task_completed: 'done',
  task_failed: 'failed',
};

/** The portal path for a task, the same one the project page links to. */
export function taskPath(projectId: string, taskId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/agent?task=${encodeURIComponent(taskId)}`;
}

export function buildPushPayload(input: PushPayloadInput): PushPayload {
  const path = taskPath(input.projectId, input.taskId);
  const projectName = truncate(input.projectName, 60);

  return {
    title: TITLES[input.event],
    body: BODIES[input.event](input.taskReference, projectName),
    // One live notification per task per kind: an approval re-requested for
    // the same task replaces its predecessor rather than stacking a second.
    tag: `task-${input.taskId}-${input.event === 'approval_required' ? 'approval' : 'outcome'}`,
    url: input.portalUrl ? `${input.portalUrl}${path}` : path,
    sound: input.soundEnabled ? SOUNDS[input.event] : null,
    event: input.event,
    taskId: input.taskId,
    projectId: input.projectId,
    requireInteraction: input.event === 'approval_required',
  };
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
