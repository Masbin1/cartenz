import type { ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, XCircle, type LucideIcon } from 'lucide-react';

type Tone = 'info' | 'warning' | 'error' | 'success';

const TONES: Record<Tone, { box: string; icon: string; Icon: LucideIcon }> = {
  info: { box: 'border-surface-border bg-surface-raised', icon: 'text-state-running', Icon: Info },
  warning: {
    box: 'border-state-waiting/25 bg-state-waiting/[0.06]',
    icon: 'text-state-waiting',
    Icon: AlertTriangle,
  },
  error: {
    box: 'border-state-failure/25 bg-state-failure/[0.05]',
    icon: 'text-state-failure',
    Icon: XCircle,
  },
  success: {
    box: 'border-state-success/25 bg-state-success/[0.06]',
    icon: 'text-state-success',
    Icon: CheckCircle2,
  },
};

/**
 * A message about what happened or what to watch for. The icon and the title
 * carry the tone; the body stays in the normal text colour so it can be read.
 */
export function Alert({
  tone = 'info',
  title,
  action,
  children,
}: {
  tone?: Tone;
  title?: string;
  /** An optional follow-up, such as "Retry" or "View logs". */
  action?: ReactNode;
  children: ReactNode;
}) {
  const { box, icon, Icon } = TONES[tone];

  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`flex animate-fade-in gap-3 rounded-xl border px-4 py-3.5 ${box}`}
    >
      <Icon className={`mt-0.5 h-[18px] w-[18px] shrink-0 ${icon}`} strokeWidth={1.75} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        {title ? <p className="text-callout font-semibold text-content">{title}</p> : null}
        <div className={`text-callout leading-relaxed text-content-muted ${title ? 'mt-0.5' : ''}`}>
          {children}
        </div>
        {action ? <div className="mt-3">{action}</div> : null}
      </div>
    </div>
  );
}
