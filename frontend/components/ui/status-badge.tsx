import type { AgentTaskStatus } from '@/lib/types';
import { TASK_STATUS_LABELS, isActiveStatus, statusTone } from '@/lib/format';

/**
 * The task status, shown consistently wherever a task appears. A pulsing dot
 * distinguishes a task that is working from one that has settled, which is the
 * distinction a user scanning a list actually needs.
 */
export function StatusBadge({
  status,
  className = '',
}: {
  status: AgentTaskStatus;
  className?: string;
}) {
  const tone = statusTone(status);
  const active = isActiveStatus(status) && status !== 'waiting_approval';

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-2xs font-medium ${tone.chip} ${className}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${tone.dot} ${active ? 'animate-pulse' : ''}`} />
      {TASK_STATUS_LABELS[status]}
    </span>
  );
}
