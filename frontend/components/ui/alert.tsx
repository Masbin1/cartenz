import type { ReactNode } from 'react';

type Tone = 'info' | 'warning' | 'error' | 'success';

const TONES: Record<Tone, string> = {
  info: 'border-state-running/30 bg-state-running/10 text-state-running',
  warning: 'border-state-waiting/30 bg-state-waiting/10 text-state-waiting',
  error: 'border-state-failure/30 bg-state-failure/10 text-state-failure',
  success: 'border-state-success/30 bg-state-success/10 text-state-success',
};

export function Alert({
  tone = 'info',
  title,
  children,
}: {
  tone?: Tone;
  title?: string;
  children: ReactNode;
}) {
  return (
    <div className={`rounded-md border px-3.5 py-3 text-xs leading-relaxed ${TONES[tone]}`}>
      {title ? <p className="mb-1 font-semibold">{title}</p> : null}
      <div className="text-content-muted">{children}</div>
    </div>
  );
}
