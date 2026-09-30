import type { ReactNode } from 'react';
import type { StatusTone } from '@/lib/format';

export type { StatusTone };

const DOT: Record<StatusTone, string> = {
  running: 'bg-state-running',
  waiting: 'bg-state-waiting',
  success: 'bg-state-success',
  failure: 'bg-state-failure',
  idle: 'bg-state-idle',
  neutral: 'bg-content-subtle',
};

const TEXT: Record<StatusTone, string> = {
  running: 'text-content',
  waiting: 'text-state-waiting',
  success: 'text-content',
  failure: 'text-state-failure',
  idle: 'text-content-muted',
  neutral: 'text-content-muted',
};

/**
 * Status, quietly: a coloured dot and a word. Colour is never the only signal:
 * the label always says what the dot means.
 *
 * Only the states that need you (waiting, failed) colour their text. A healthy
 * or working state keeps its text neutral so a list of them stays calm.
 */
export function StatusDot({
  tone,
  children,
  pulse = false,
  size = 'default',
  className = '',
}: {
  tone: StatusTone;
  children: ReactNode;
  /** A pulsing dot marks something in progress. */
  pulse?: boolean;
  size?: 'default' | 'small';
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-2 font-medium ${
        size === 'small' ? 'text-meta' : 'text-callout'
      } ${TEXT[tone]} ${className}`}
    >
      <span className="relative flex h-2 w-2 shrink-0" aria-hidden="true">
        {pulse ? (
          <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${DOT[tone]}`} />
        ) : null}
        <span className={`relative inline-flex h-2 w-2 rounded-full ${DOT[tone]}`} />
      </span>
      {children}
    </span>
  );
}
