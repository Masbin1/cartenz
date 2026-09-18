'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { useAuth } from '@/lib/auth';
import { USER_REGION_LABELS } from '@/lib/types';
import { CartenzMark } from '@/components/ui/cartenz-mark';

/**
 * The application frame: a narrow top bar carrying identity, region and
 * global navigation, with the page below it.
 *
 * The bar is deliberately thin. This is a working environment, and vertical
 * space belongs to the agent workspace rather than to chrome.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { user, signOut } = useAuth();
  const pathname = usePathname();

  const navigation = [
    { href: '/dashboard', label: 'Dashboard' },
    { href: '/projects', label: 'Projects' },
    { href: '/users', label: 'Users' },
    { href: '/settings', label: 'Settings' },
  ];

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-20 border-b border-surface-border bg-surface/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-6 px-5">
          <Link href="/dashboard" className="flex items-center gap-2.5">
            <CartenzMark size={22} />
            <span className="text-sm font-semibold tracking-tight">
              Cartenz
              <span className="ml-1.5 font-normal text-content-subtle">by LinkedERP</span>
            </span>
          </Link>

          <nav className="flex items-center gap-1">
            {navigation.map((item) => {
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
                    active
                      ? 'bg-surface-overlay text-content'
                      : 'text-content-muted hover:text-content'
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            {user ? (
              <>
                <span className="rounded border border-surface-border px-1.5 py-0.5 text-2xs text-content-muted">
                  {USER_REGION_LABELS[user.region]}
                </span>
                <span className="rounded border border-surface-border px-1.5 py-0.5 text-2xs uppercase tracking-wide text-content-subtle">
                  {user.isAdmin ? 'Admin' : 'Member'}
                </span>
              </>
            ) : null}

            <Link
              href="/account"
              className={`hidden text-xs sm:inline ${
                pathname === '/account'
                  ? 'text-content'
                  : 'text-content-muted hover:text-content'
              }`}
            >
              {user?.name}
            </Link>

            <button type="button" onClick={() => void signOut()} className="btn-ghost px-2 py-1 text-xs">
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1">{children}</main>
    </div>
  );
}
