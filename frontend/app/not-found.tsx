import Link from 'next/link';
import { CartenzMark } from '@/components/ui/cartenz-mark';

/**
 * Unknown routes, and routes this person may not see. The copy covers both,
 * so it does not confirm that a restricted page exists.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-16 sm:px-6">
      <div className="flex w-full max-w-md animate-rise-in flex-col items-center text-center">
        <CartenzMark size={40} className="opacity-90" />
        <p className="mt-6 text-meta text-content-subtle">Error 404</p>
        <h1 className="mt-1 text-display-sm text-content">Page not found</h1>
        <p className="mt-3 text-body text-content-muted">
          This page does not exist, or you do not have access to it.
        </p>
        <Link href="/dashboard" className="btn-primary mt-8">
          Go to Overview
        </Link>
      </div>
    </div>
  );
}
