import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center px-5">
      <div className="panel max-w-md p-6 text-center">
        <h1 className="text-sm font-semibold">Page not found</h1>
        <p className="mt-2 text-xs leading-relaxed text-content-muted">
          That page does not exist, or you do not have access to it.
        </p>
        <Link href="/dashboard" className="btn-primary mt-5">
          Go to the dashboard
        </Link>
      </div>
    </div>
  );
}
