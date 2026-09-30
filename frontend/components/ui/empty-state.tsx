import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

/**
 * An intentional absence. Says what is missing, why it matters, and what to do
 * next, in that order.
 *
 * `compact` is for an empty region inside a column or panel; the default is for
 * an empty page or a page's main content.
 */
export function EmptyState({
  title,
  description,
  action,
  icon: Icon,
  compact = false,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  icon?: LucideIcon;
  compact?: boolean;
}) {
  return (
    <div
      className={`flex flex-col items-center justify-center text-center ${
        compact ? 'px-6 py-10' : 'px-6 py-20'
      }`}
    >
      {Icon ? (
        <span
          className={`mb-4 flex items-center justify-center rounded-2xl bg-surface-overlay text-content-subtle ${
            compact ? 'h-10 w-10' : 'h-12 w-12'
          }`}
          aria-hidden="true"
        >
          <Icon className={compact ? 'h-5 w-5' : 'h-6 w-6'} strokeWidth={1.5} />
        </span>
      ) : null}
      <p className={compact ? 'text-body font-semibold text-content' : 'text-headline text-content'}>
        {title}
      </p>
      <p
        className={`mt-1.5 max-w-sm text-content-muted ${
          compact ? 'text-callout' : 'text-body'
        }`}
      >
        {description}
      </p>
      {action ? <div className={compact ? 'mt-5' : 'mt-6'}>{action}</div> : null}
    </div>
  );
}
