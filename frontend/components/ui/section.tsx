import type { ReactNode } from 'react';

/**
 * A titled region of a page, laid out openly: a heading, an optional line of
 * context, then the content. No box. Sections are separated by whitespace, and
 * by a hairline only when `divided` is set and scanning benefits from it.
 *
 * Reach for `.panel` only when the content inside genuinely needs containment
 * (a form, a list that scrolls, a group of controls that act together).
 */
export function Section({
  title,
  description,
  actions,
  divided = false,
  size = 'default',
  id,
  className = '',
  children,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  divided?: boolean;
  /** `small` for a section inside a column or a panel. */
  size?: 'default' | 'small';
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  const hasHeader = title || description || actions;

  return (
    <section
      id={id}
      className={`${divided ? 'divider pt-10' : ''} ${className}`}
      aria-labelledby={id && title ? `${id}-title` : undefined}
    >
      {hasHeader ? (
        <div className={`flex flex-wrap items-end justify-between gap-3 ${size === 'small' ? 'mb-4' : 'mb-6'}`}>
          <div className="min-w-0">
            {title ? (
              <h2
                id={id ? `${id}-title` : undefined}
                className={size === 'small' ? 'text-headline text-content' : 'section-title'}
              >
                {title}
              </h2>
            ) : null}
            {description ? (
              <p className={`max-w-2xl text-content-muted ${size === 'small' ? 'mt-1 text-callout' : 'mt-1.5 text-body'}`}>
                {description}
              </p>
            ) : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}
