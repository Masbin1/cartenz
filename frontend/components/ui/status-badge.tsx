import type { AgentTaskStatus } from '@/lib/types';
import { TASK_STATUS_LABELS, isActiveStatus, statusTone } from '@/lib/format';
import { StatusDot } from '@/components/ui/status-dot';

/**
 * The task status, shown consistently wherever a task appears. A pulsing dot
 * distinguishes a task that is working from one that has settled, which is the
 * distinction a user scanning a list actually needs.
 */
export function StatusBadge({
  status,
  size = 'small',
  className = '',
}: {
  status: AgentTaskStatus;
  size?: 'default' | 'small';
  className?: string;
}) {
  const active = isActiveStatus(status) && status !== 'waiting_approval';

  return (
    <StatusDot tone={statusTone(status).tone} pulse={active} size={size} className={className}>
      {TASK_STATUS_LABELS[status]}
    </StatusDot>
  );
}
