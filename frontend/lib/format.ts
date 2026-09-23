import type { AgentTaskStatus } from './types';

/** The meaning a status colour carries. See components/ui/status-dot.tsx. */
export type StatusTone = 'running' | 'waiting' | 'success' | 'failure' | 'idle' | 'neutral';

/** Human labels for task states. Mirrors TASK_STATUS_LABELS on the server. */
export const TASK_STATUS_LABELS: Record<AgentTaskStatus, string> = {
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

/**
 * The status tone for a task state. Grouped by meaning rather than by state, so
 * the palette carries information: blue is working, amber needs you, green
 * succeeded, red failed, grey is inert.
 */
export function statusTone(status: AgentTaskStatus): { tone: StatusTone } {
  switch (status) {
    case 'completed':
      return { tone: 'success' };
    case 'failed':
      return { tone: 'failure' };
    case 'cancelled':
    case 'created':
    case 'queued':
      return { tone: 'idle' };
    case 'waiting_approval':
      return { tone: 'waiting' };
    default:
      return { tone: 'running' };
  }
}

export function isActiveStatus(status: AgentTaskStatus): boolean {
  return !['completed', 'failed', 'cancelled'].includes(status);
}

/** Short relative time, in words that read naturally: "3 min ago". */
export function relativeTime(iso: string): string {
  const elapsed = Date.now() - new Date(iso).getTime();
  const seconds = Math.round(elapsed / 1000);

  if (seconds < 10) return 'just now';
  if (seconds < 60) return 'less than a minute ago';

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;

  const days = Math.round(hours / 24);
  if (days < 30) return days === 1 ? 'yesterday' : `${days} days ago`;

  return new Date(iso).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' });
}

export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-ZA', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export const PROJECT_TYPE_LABELS: Record<string, string> = {
  repository: 'Git repository',
  odoo_sh: 'Odoo.sh',
  on_premise: 'On-premise',
  odoo_online: 'Odoo Online',
  ai_project: 'AI project',
};

export function humanise(value: string): string {
  return value.replace(/_/g, ' ').replace(/^./, (character) => character.toUpperCase());
}
