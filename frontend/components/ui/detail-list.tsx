import type { ReactNode } from 'react';

/**
 * Label and value pairs, for the supporting facts about an object (branch,
 * version, repository, identifiers). Labels recede; values carry the weight.
 *
 * `columns` lays the pairs out side by side on wide screens; on narrow ones
 * they always stack.
 */
export function DetailList({
  children,
  columns = 1,
  className = '',
}: {
  children: ReactNode;
  columns?: 1 | 2 | 3;
  className?: string;
}) {
  const grid =
    columns === 3 ? 'sm:grid-cols-2 lg:grid-cols-3' : columns === 2 ? 'sm:grid-cols-2' : '';
  return <dl className={`grid gap-x-10 gap-y-5 ${grid} ${className}`}>{children}</dl>;
}

export function DetailItem({
  label,
  children,
  mono = false,
}: {
  label: ReactNode;
  children: ReactNode;
  /** For identifiers, hashes, paths and URLs. */
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-meta text-content-subtle">{label}</dt>
      <dd
        className={`mt-1 break-words text-content ${
          mono ? 'font-mono text-meta' : 'text-body'
        }`}
      >
        {children}
      </dd>
    </div>
  );
}
