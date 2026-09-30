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
import { detachPushSubscription, listenForPush, registerServiceWorker } from './push';
import type { CurrentUser } from './types';

interface AuthState {
  user: CurrentUser | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  register: (input: {
    email: string;
    password: string;
    name: string;
    region: string;
  }) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

/**
 * Session state for the portal.
 *
 * Only the caller is held here. There is no selected organisation to remember:
 * one flat space means the region on the account is the only scope there is
 * (ADR-044).
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  const load = useCallback(async () => {
    if (!tokenStore.access) {
      setUser(null);
      setLoading(false);
      return;
    }
    try {
      setUser(await api.users.me());
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

  // Push (ADR-065): the service worker is registered for anyone signed in, so
  // it is ready the moment permission is granted. Subscribing itself is done
  // by <PushOptIn /> in the app shell, which turns push on by default.
  useEffect(() => {
    if (!user?.id) return;
    void registerServiceWorker();
    return listenForPush();
  }, [user?.id]);

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
    async (input: { email: string; password: string; name: string; region: string }) => {
      const tokens = await api.auth.register(input);
      tokenStore.set(tokens);
      await load();
      router.push('/dashboard');
    },
    [load, router],
  );

  const signOut = useCallback(async () => {
    // Detach this browser from the account before the token goes, so a shared
    // machine stops receiving the previous person's approvals. The browser's
    // own subscription is kept: whoever signs in next is re-attached to it by
    // <PushOptIn />, without being asked for permission again.
    await detachPushSubscription();
    try {
      await api.auth.logout(tokenStore.refresh);
    } catch {
      // A failed sign-out must still clear the client: the tokens are the thing
      // that matters locally, and the server revokes on the next refresh.
    }
    tokenStore.clear();
    setUser(null);
    router.push('/login');
  }, [router]);

  const value = useMemo<AuthState>(
    () => ({ user, loading, signIn, register, signOut, refresh: load }),
    [user, loading, signIn, register, signOut, load],
  );

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
