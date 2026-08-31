import type { AgentTaskStatus } from './types';

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
 * Status colour classes. Grouped by meaning rather than by state, so the palette
 * carries information: blue is working, amber needs you, green succeeded, red
 * failed, grey is inert.
 */
export function statusTone(status: AgentTaskStatus): {
  dot: string;
  text: string;
  chip: string;
} {
  switch (status) {
    case 'completed':
      return {
        dot: 'bg-state-success',
        text: 'text-state-success',
        chip: 'border-state-success/30 bg-state-success/10 text-state-success',
      };
    case 'failed':
      return {
        dot: 'bg-state-failure',
        text: 'text-state-failure',
        chip: 'border-state-failure/30 bg-state-failure/10 text-state-failure',
      };
    case 'cancelled':
      return {
        dot: 'bg-state-idle',
        text: 'text-content-subtle',
        chip: 'border-state-idle/30 bg-state-idle/10 text-content-subtle',
      };
    case 'waiting_approval':
      return {
        dot: 'bg-state-waiting',
        text: 'text-state-waiting',
        chip: 'border-state-waiting/30 bg-state-waiting/10 text-state-waiting',
      };
    case 'created':
    case 'queued':
      return {
        dot: 'bg-state-idle',
        text: 'text-content-muted',
        chip: 'border-state-idle/30 bg-state-idle/10 text-content-muted',
      };
    default:
      return {
        dot: 'bg-state-running',
        text: 'text-state-running',
        chip: 'border-state-running/30 bg-state-running/10 text-state-running',
      };
  }
}

export function isActiveStatus(status: AgentTaskStatus): boolean {
  return !['completed', 'failed', 'cancelled'].includes(status);
}

/** Short relative time. Kept terse: the workspace shows many timestamps. */
export function relativeTime(iso: string): string {
  const elapsed = Date.now() - new Date(iso).getTime();
  const seconds = Math.round(elapsed / 1000);

  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;

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
