import { CartenzMark } from '@/components/ui/cartenz-mark';

export function Spinner({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2.5" opacity="0.2" />
      <path
        d="M22 12a10 10 0 0 0-10-10"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Shown only while the session itself resolves, before any page layout exists.
 * Once a page has its frame, load its content in place with skeletons instead.
 */
export function PageLoading({ label = 'Loading' }: { label?: string }) {
  return (
    <div
      className="flex min-h-[70vh] animate-fade-in flex-col items-center justify-center gap-4 text-content-subtle"
      role="status"
      aria-live="polite"
    >
      <CartenzMark size={28} className="opacity-80" />
      <span className="flex items-center gap-2 text-callout">
        <Spinner className="h-3.5 w-3.5" />
        {label}
      </span>
    </div>
  );
}
