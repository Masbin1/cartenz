'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { ApiError, api } from '@/lib/api';
import { Alert } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';
import { CartenzMark } from '@/components/ui/cartenz-mark';

/**
 * Sign-in: a single calm column with the mark, one question and one button.
 * There is no application frame here; the shell starts once there is a session.
 * A browser that has not passed a code since the last password change is asked
 * for the 6-digit code mailed after the password (ADR-072 addendum 4).
 */
export default function LoginPage() {
  const { signIn, verifySignIn, user, loading } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);
  // Sign-up: the first, admin, account; then anyone from an allowed domain while mail works (ADR-072).
  const [registration, setRegistration] = useState({ open: false, firstAccount: false });

  useEffect(() => {
    if (!loading && user) router.replace('/dashboard');
  }, [loading, user, router]);

  useEffect(() => {
    api.auth
      .registration()
      .then(setRegistration)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = setTimeout(() => setResendIn((seconds) => seconds - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendIn]);

  const attempt = async (action: () => Promise<void>) => {
    setError(null);
    setNotice(null);
    setSubmitting(true);
    try {
      await action();
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

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    void attempt(async () => {
      const answer = await signIn(email, password);
      if (answer) {
        setChallenge(answer.challenge);
        setResendIn(120);
      }
    });
  };

  const verify = (event: React.FormEvent) => {
    event.preventDefault();
    if (challenge) void attempt(() => verifySignIn(challenge, code));
  };

  const resend = () =>
    void attempt(async () => {
      if (!challenge) return;
      setChallenge((await api.auth.resendLogin(challenge)).challenge);
      setCode('');
      setResendIn(120);
      setNotice('A new code is on its way. Earlier codes no longer work.');
    });

  const startOver = () => {
    setChallenge(null);
    setCode('');
    setError(null);
    setNotice(null);
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
          {challenge ? (
            <form onSubmit={verify} className="space-y-5">
              <Alert tone="info">
                This browser is new to your account, so we emailed a 6-digit code to {email}. It
                expires in 10 minutes.
              </Alert>
              <div>
                <label htmlFor="code" className="field-label">
                  Sign-in code
                </label>
                <input
                  id="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  required
                  pattern="\d{6}"
                  maxLength={6}
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
                  className="field-input text-center font-mono text-title tracking-[0.5em]"
                  placeholder="000000"
                />
                <p className="field-hint">This browser will not be asked again for 30 days.</p>
              </div>

              {error ? <Alert tone="error">{error}</Alert> : null}
              {notice ? <Alert tone="success">{notice}</Alert> : null}

              <button type="submit" disabled={submitting} className="btn-primary h-11 w-full">
                {submitting ? <Spinner /> : null}
                {submitting ? 'Checking' : 'Continue'}
              </button>

              <p className="text-center text-callout text-content-muted">
                <button
                  type="button"
                  className="link"
                  onClick={resend}
                  disabled={submitting || resendIn > 0}
                >
                  {resendIn > 0 ? `Send a new code in ${resendIn}s` : 'Send a new code'}
                </button>
                {' · '}
                <button type="button" className="link" onClick={startOver} disabled={submitting}>
                  Use another account
                </button>
              </p>
            </form>
          ) : (
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
                <div className="flex items-baseline justify-between">
                  <label htmlFor="password" className="field-label">
                    Password
                  </label>
                  <Link href="/forgot-password" className="link text-meta">
                    Forgot your password?
                  </Link>
                </div>
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
          )}
        </div>

        <p className="mt-8 text-center text-callout text-content-muted">
          {registration.firstAccount ? (
            <>
              Setting up this deployment?{' '}
              <Link href="/register" className="link">
                Create the first account
              </Link>
            </>
          ) : registration.open ? (
            <>
              No account yet?{' '}
              <Link href="/register" className="link">
                Create one with your work email
              </Link>
            </>
          ) : (
            'No account yet? Ask an administrator for an invitation.'
          )}
        </p>

        <p className="mt-12 text-center text-caption text-content-subtle">Cartenz by LinkedERP</p>
      </div>
    </div>
  );
}
