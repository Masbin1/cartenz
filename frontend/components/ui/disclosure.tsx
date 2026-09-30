'use client';

import { useId, useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';

/**
 * Progressive disclosure: technical detail that is available without being
 * constantly visible. The summary says what is inside ("Deployment details",
 * "Show 12 files"), so the reader can decide whether to open it.
 */
export function Disclosure({
  summary,
  hint,
  defaultOpen = false,
  children,
  className = '',
}: {
  summary: ReactNode;
  /** Quiet text to the right of the summary, such as a count. */
  hint?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const regionId = useId();

  return (
    <div className={className}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => setOpen((value) => !value)}
        className="group -mx-2 flex w-[calc(100%+1rem)] items-center gap-2 rounded-lg px-2 py-1.5 text-left text-callout font-medium text-content-muted transition-colors hover:text-content"
      >
        <ChevronRight
          className={`h-4 w-4 shrink-0 text-content-subtle transition-transform ${open ? 'rotate-90' : ''}`}
          strokeWidth={1.75}
          aria-hidden="true"
        />
        <span className="flex-1">{summary}</span>
        {hint ? <span className="text-meta font-normal text-content-subtle">{hint}</span> : null}
      </button>
      {open ? (
        <div id={regionId} className="mt-3 animate-rise-in">
          {children}
        </div>
      ) : null}
    </div>
  );
}
