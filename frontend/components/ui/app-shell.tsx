'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { useAuth } from '@/lib/auth';

/**
 * The application frame: a narrow top bar carrying identity, organisation and
 * global navigation, with the page below it.
 *
 * The bar is deliberately thin. This is a working environment, and vertical
 * space belongs to the agent workspace rather than to chrome.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { user, organization, organizations, selectOrganization, signOut } = useAuth();
  const pathname = usePathname();

  const navigation = [
    { href: '/dashboard', label: 'Dashboard' },
    { href: '/projects', label: 'Projects' },
    { href: '/settings', label: 'Settings' },
  ];

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-20 border-b border-surface-border bg-surface/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-6 px-5">
          <Link href="/dashboard" className="flex items-center gap-2.5">
            <span className="flex h-6 w-6 items-center justify-center rounded bg-accent text-2xs font-bold text-white">
              L
            </span>
            <span className="text-sm font-semibold tracking-tight">
              LinkedERP
              <span className="ml-1.5 font-normal text-content-subtle">AI Development Agent</span>
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
            {organizations.length > 1 ? (
              <select
                value={organization?.organizationId ?? ''}
                onChange={(event) => selectOrganization(event.target.value)}
                className="rounded-md border border-surface-border bg-surface-raised px-2 py-1 text-xs text-content"
                aria-label="Organisation"
              >
                {organizations.map((entry) => (
                  <option key={entry.organizationId} value={entry.organizationId}>
                    {entry.organizationName}
                  </option>
                ))}
              </select>
            ) : organization ? (
              <span className="text-xs text-content-muted">{organization.organizationName}</span>
            ) : null}

            {organization ? (
              <span className="rounded border border-surface-border px-1.5 py-0.5 text-2xs uppercase tracking-wide text-content-subtle">
                {organization.role}
              </span>
            ) : null}

            <span className="hidden text-xs text-content-muted sm:inline">{user?.name}</span>

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
