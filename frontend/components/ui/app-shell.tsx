'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import {
  ChevronsUpDown,
  FolderGit2,
  LayoutGrid,
  LogOut,
  Menu,
  Settings,
  UserRound,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { USER_REGION_LABELS } from '@/lib/types';
import { CartenzMark } from '@/components/ui/cartenz-mark';
import { ActionMenu } from '@/components/ui/action-menu';
import { ThemeSwitcher } from '@/components/ui/theme-switcher';
import { PushOptIn } from '@/components/ui/push-opt-in';

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

/**
 * Primary navigation holds only the places people go every day; the
 * administrative areas sit below a divider. Anything more specific (a
 * project's agent, its settings) is contextual navigation inside the page.
 */
const PRIMARY: NavItem[] = [
  { href: '/dashboard', label: 'Overview', icon: LayoutGrid },
  { href: '/projects', label: 'Projects', icon: FolderGit2 },
];

const ADMINISTRATION: NavItem[] = [
  { href: '/users', label: 'Users', icon: Users },
  { href: '/settings', label: 'Settings', icon: Settings },
];

/**
 * The application frame: a quiet sidebar with identity, navigation and the
 * account, and the page beside it. On narrow screens the sidebar becomes a
 * drawer behind a menu button, so the content keeps the full width.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Close the drawer on navigation, and let Escape close it.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrawerOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  return (
    <div className="min-h-screen lg:pl-64">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-64 border-r border-surface-border bg-surface lg:flex">
        <Sidebar pathname={pathname} />
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-surface-border bg-surface/90 px-4 backdrop-blur-md lg:hidden">
        <button
          type="button"
          className="icon-btn -ml-2"
          aria-label="Open navigation"
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen(true)}
        >
          <Menu className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
        </button>
        <Link href="/dashboard" className="flex items-center gap-2">
          <CartenzMark size={22} />
          <span className="text-body font-semibold tracking-tight">Cartenz</span>
        </Link>
      </header>

      {/* Mobile drawer */}
      {drawerOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <button
            type="button"
            aria-label="Close navigation"
            className="absolute inset-0 animate-fade-in bg-black/30 backdrop-blur-[2px]"
            onClick={() => setDrawerOpen(false)}
          />
          <aside className="relative flex h-full w-72 max-w-[85vw] animate-slide-in bg-surface shadow-float">
            <button
              type="button"
              className="icon-btn absolute right-3 top-3"
              aria-label="Close navigation"
              onClick={() => setDrawerOpen(false)}
            >
              <X className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
            </button>
            <Sidebar pathname={pathname} />
          </aside>
        </div>
      ) : null}

      <main className="min-w-0">
        <PushOptIn />
        {children}
      </main>
    </div>
  );
}

function Sidebar({ pathname }: { pathname: string }) {
  return (
    <div className="flex h-full w-full flex-col px-3 py-5">
      <Link href="/dashboard" className="mb-8 flex items-center gap-2.5 px-3">
        <CartenzMark size={26} />
        <span className="flex flex-col leading-none">
          <span className="text-headline tracking-tight text-content">Cartenz</span>
          <span className="mt-1 text-caption text-content-subtle">by LinkedERP</span>
        </span>
      </Link>

      <nav aria-label="Primary" className="flex flex-1 flex-col">
        <NavGroup items={PRIMARY} pathname={pathname} />
        <div className="mx-3 my-4 border-t border-surface-border" />
        <NavGroup items={ADMINISTRATION} pathname={pathname} />
      </nav>

      <ThemeSwitcher className="mx-3 mb-3" />
      <AccountMenu pathname={pathname} />
    </div>
  );
}

function NavGroup({ items, pathname }: { items: NavItem[]; pathname: string }) {
  return (
    <ul className="space-y-0.5">
      {items.map(({ href, label, icon: Icon }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <li key={href}>
            <Link
              href={href}
              aria-current={active ? 'page' : undefined}
              className={`group flex items-center gap-3 rounded-control px-3 py-2 text-callout font-medium transition-colors ${
                active
                  ? 'bg-surface-raised text-content ring-1 ring-surface-border'
                  : 'text-content-muted hover:bg-surface-overlay/70 hover:text-content'
              }`}
            >
              <Icon
                className={`h-[18px] w-[18px] shrink-0 ${active ? 'text-accent' : 'text-content-subtle group-hover:text-content-muted'}`}
                strokeWidth={1.75}
                aria-hidden="true"
              />
              {label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function AccountMenu({ pathname }: { pathname: string }) {
  const { user, signOut } = useAuth();
  if (!user) return null;

  const initials = user.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');

  return (
    <ActionMenu
      label="Account"
      side="top"
      align="start"
      block
      items={[
        { label: 'Account', href: '/account', icon: UserRound },
        { label: 'Sign out', icon: LogOut, onSelect: () => void signOut(), separated: true },
      ]}
      trigger={
        <span
          className={`flex w-full items-center gap-3 rounded-control px-3 py-2.5 transition-colors hover:bg-surface-overlay/70 ${
            pathname === '/account' ? 'bg-surface-raised ring-1 ring-surface-border' : ''
          }`}
        >
          <span
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-overlay text-meta font-semibold text-content-muted"
            aria-hidden="true"
          >
            {initials || '?'}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-callout font-medium text-content">{user.name}</span>
            <span className="block truncate text-caption text-content-subtle">
              {USER_REGION_LABELS[user.region]} · {user.isAdmin ? 'Admin' : 'Member'}
            </span>
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 text-content-subtle" strokeWidth={1.75} aria-hidden="true" />
        </span>
      }
    />
  );
}
