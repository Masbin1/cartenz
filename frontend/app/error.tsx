'use client';

import { useEffect } from 'react';

/**
 * Route-level error boundary. Shows the digest rather than the stack: the detail
 * belongs in the server log, not in the browser.
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center px-5">
      <div className="panel max-w-md p-6 text-center">
        <h1 className="text-sm font-semibold">Something went wrong</h1>
        <p className="mt-2 text-xs leading-relaxed text-content-muted">
          The page could not be rendered. Retrying may resolve it; if it does not, quote the
          reference below when reporting the problem.
        </p>
        {error.digest ? (
          <p className="mt-3 font-mono text-2xs text-content-subtle">{error.digest}</p>
        ) : null}
        <button type="button" onClick={reset} className="btn-primary mt-5">
          Try again
        </button>
      </div>
    </div>
  );
}
