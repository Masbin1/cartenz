'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { ApiError } from '@/lib/api';
import { Spinner } from '@/components/ui/spinner';

export default function LoginPage() {
  const { signIn, user, loading } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!loading && user) router.replace('/dashboard');
  }, [loading, user, router]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await signIn(email, password);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : 'Could not reach the API. Check that the backend is running.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-5 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded bg-accent text-xs font-bold text-white">
            L
          </span>
          <div>
            <p className="text-sm font-semibold tracking-tight">LinkedERP</p>
            <p className="text-2xs uppercase tracking-widest text-content-subtle">
              AI Development Agent
            </p>
          </div>
        </div>

        <div className="panel p-6">
          <h1 className="text-base font-semibold">Sign in</h1>
          <p className="mt-1 text-xs text-content-muted">
            Use the email address and password for your LinkedERP account.
          </p>

          <form onSubmit={submit} className="mt-6 space-y-4">
            <div>
              <label htmlFor="email" className="field-label">
                Email address
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="field-input"
                placeholder="you@organisation.com"
              />
            </div>

            <div>
              <label htmlFor="password" className="field-label">
                Password
              </label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="field-input"
                placeholder="••••••••••••"
              />
            </div>

            {error ? (
              <p className="rounded-md border border-state-failure/30 bg-state-failure/10 px-3 py-2 text-xs text-state-failure">
                {error}
              </p>
            ) : null}

            <button type="submit" disabled={submitting} className="btn-primary w-full">
              {submitting ? <Spinner /> : null}
              {submitting ? 'Signing in' : 'Sign in'}
            </button>
          </form>

          <p className="mt-5 text-xs text-content-muted">
            No account yet?{' '}
            <Link href="/register" className="text-accent hover:underline">
              Create one
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
