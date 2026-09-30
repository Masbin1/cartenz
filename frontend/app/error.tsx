'use client';

import { useEffect } from 'react';
import { CartenzMark } from '@/components/ui/cartenz-mark';

/**
 * Route-level error boundary. Shows the digest rather than the stack: the detail
 * belongs in the server log, not in the browser.
 *
 * Centred and quiet, with one action. The digest is the only technical detail
 * shown, as a reference to quote.
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
    <div className="flex min-h-screen items-center justify-center px-4 py-16 sm:px-6">
      <div className="flex w-full max-w-md animate-rise-in flex-col items-center text-center">
        <CartenzMark size={40} className="opacity-90" />
        <h1 className="mt-6 text-display-sm text-content">Something went wrong</h1>
        <p className="mt-3 text-body text-content-muted">
          This page could not be shown. Try again; if the problem continues, quote the reference
          below when you report it.
        </p>
        {error.digest ? (
          <p className="mt-5 flex flex-wrap items-center justify-center gap-2 text-meta text-content-subtle">
            Reference
            <span className="code-chip break-all">{error.digest}</span>
          </p>
        ) : null}
        <button type="button" onClick={reset} className="btn-primary mt-8">
          Try again
        </button>
      </div>
    </div>
  );
}
