'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import { api, tokenStore } from './api';
import type { CurrentUser, OrganizationMembership } from './types';

interface AuthState {
  user: CurrentUser | null;
  organization: OrganizationMembership | null;
  organizations: OrganizationMembership[];
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  register: (input: {
    email: string;
    password: string;
    name: string;
    organizationName: string;
  }) => Promise<void>;
  signOut: () => Promise<void>;
  selectOrganization: (organizationId: string) => void;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

const SELECTED_ORG_KEY = 'linkederp.organizationId';

/**
 * Session state for the portal.
 *
 * The selected organisation is held here rather than in a route parameter,
 * because every request the portal makes is scoped to one organisation and the
 * user changes it rarely. It persists in sessionStorage alongside the tokens, so
 * a reload does not silently switch which organisation the user is looking at.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  const load = useCallback(async () => {
    if (!tokenStore.access) {
      setUser(null);
      setLoading(false);
      return;
    }
    try {
      const current = await api.users.me();
      setUser(current);

      const stored =
        typeof window === 'undefined' ? null : window.sessionStorage.getItem(SELECTED_ORG_KEY);
      const valid = current.organizations.some((entry) => entry.organizationId === stored);
      setOrganizationId(valid ? stored : (current.organizations[0]?.organizationId ?? null));
    } catch {
      tokenStore.clear();
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selectOrganization = useCallback((next: string) => {
    setOrganizationId(next);
    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem(SELECTED_ORG_KEY, next);
    }
  }, []);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const tokens = await api.auth.login({ email, password });
      tokenStore.set(tokens);
      await load();
      router.push('/dashboard');
    },
    [load, router],
  );

  const register = useCallback(
    async (input: { email: string; password: string; name: string; organizationName: string }) => {
      const tokens = await api.auth.register(input);
      tokenStore.set(tokens);
      await load();
      router.push('/dashboard');
    },
    [load, router],
  );

  const signOut = useCallback(async () => {
    try {
      await api.auth.logout(tokenStore.refresh);
    } catch {
      // A failed sign-out must still clear the client: the tokens are the thing
      // that matters locally, and the server revokes on the next refresh.
    }
    tokenStore.clear();
    if (typeof window !== 'undefined') {
      window.sessionStorage.removeItem(SELECTED_ORG_KEY);
    }
    setUser(null);
    setOrganizationId(null);
    router.push('/login');
  }, [router]);

  const value = useMemo<AuthState>(() => {
    const organizations = user?.organizations ?? [];
    return {
      user,
      organizations,
      organization:
        organizations.find((entry) => entry.organizationId === organizationId) ??
        organizations[0] ??
        null,
      loading,
      signIn,
      register,
      signOut,
      selectOrganization,
      refresh: load,
    };
  }, [user, organizationId, loading, signIn, register, signOut, selectOrganization, load]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used inside AuthProvider');
  }
  return context;
}

/**
 * Redirects to sign-in when there is no session. Returns the auth state so a
 * page can render a loading state while the session is being resolved.
 */
export function useRequireAuth(): AuthState {
  const auth = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!auth.loading && !auth.user) {
      router.replace('/login');
    }
  }, [auth.loading, auth.user, router]);

  return auth;
}
