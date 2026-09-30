import Link from 'next/link';
import type { ReactNode } from 'react';
import { ChevronLeft } from 'lucide-react';

/**
 * The top of a page: where you are, why it matters, and the one thing you are
 * most likely to do next.
 *
 * The title dominates. The description is one short line of context. Actions
 * sit to the right on wide screens and below on narrow ones; keep them to one
 * primary action and, at most, one secondary or an action menu.
 */
export function PageHeader({
  title,
  description,
  actions,
  back,
  meta,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** A single step up the hierarchy, shown above the title. */
  back?: { href: string; label: string };
  /** Quiet supporting facts under the description, such as status or version. */
  meta?: ReactNode;
}) {
  return (
    <header className="mb-10 animate-rise-in sm:mb-12">
      {back ? <BackLink href={back.href} label={back.label} /> : null}
      <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-display-sm text-content sm:text-display">{title}</h1>
          {description ? (
            <p className="mt-2 max-w-2xl text-body text-content-muted sm:text-[1.0625rem] sm:leading-7">
              {description}
            </p>
          ) : null}
          {meta ? <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">{meta}</div> : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}

export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="-ml-1 mb-4 inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-callout text-content-subtle transition-colors hover:text-content"
    >
      <ChevronLeft className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
      {label}
    </Link>
  );
}
