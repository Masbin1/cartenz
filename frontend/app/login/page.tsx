'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { ApiError } from '@/lib/api';
import { Alert } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';
import { CartenzMark } from '@/components/ui/cartenz-mark';

/**
 * Sign-in: a single calm column with the mark, one question and one button.
 * There is no application frame here; the shell starts once there is a session.
 */
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
    <div className="flex min-h-screen flex-col items-center justify-center px-4 py-16 sm:px-6">
      <div className="w-full max-w-[400px] animate-rise-in">
        <div className="mb-10 flex flex-col items-center text-center">
          <CartenzMark size={44} />
          <h1 className="mt-6 text-display-sm text-content">Sign in to Cartenz</h1>
          <p className="mt-2 text-body text-content-muted">
            Use the email address and password for your LinkedERP account.
          </p>
        </div>

        <div className="panel p-6 sm:p-8">
          <form onSubmit={submit} className="space-y-5">
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

            {error ? <Alert tone="error">{error}</Alert> : null}

            <button type="submit" disabled={submitting} className="btn-primary h-11 w-full">
              {submitting ? <Spinner /> : null}
              {submitting ? 'Signing in' : 'Sign in'}
            </button>
          </form>
        </div>

        <p className="mt-8 text-center text-callout text-content-muted">
          No account yet?{' '}
          <Link href="/register" className="link">
            Create one
          </Link>
        </p>

        <p className="mt-12 text-center text-caption text-content-subtle">Cartenz by LinkedERP</p>
      </div>
    </div>
  );
}
