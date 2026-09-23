/**
 * Placeholders that hold the shape of content while it loads, so the layout
 * does not jump when it arrives.
 */
export function Skeleton({ className = 'h-4 w-full' }: { className?: string }) {
  return <span className={`skeleton block ${className}`} aria-hidden="true" />;
}

/** A stack of list-row placeholders: a title line and a metadata line each. */
export function SkeletonRows({ rows = 4, className = '' }: { rows?: number; className?: string }) {
  return (
    <div className={`space-y-1 ${className}`} role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-4 px-4 py-4">
          <div className="flex-1 space-y-2">
            <Skeleton className={`h-4 ${index % 2 === 0 ? 'w-2/5' : 'w-1/3'}`} />
            <Skeleton className="h-3 w-1/4" />
          </div>
          <Skeleton className="h-3 w-16" />
        </div>
      ))}
    </div>
  );
}

/** A block of text-line placeholders, for a paragraph or a detail list. */
export function SkeletonText({ lines = 3, className = '' }: { lines?: number; className?: string }) {
  const widths = ['w-full', 'w-11/12', 'w-4/5', 'w-2/3'];
  return (
    <div className={`space-y-2.5 ${className}`} role="status" aria-label="Loading">
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={index} className={`h-3.5 ${widths[index % widths.length]}`} />
      ))}
    </div>
  );
}
