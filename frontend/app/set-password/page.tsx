'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { Alert } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';
import { CartenzMark } from '@/components/ui/cartenz-mark';

const MINIMUM_PASSWORD_LENGTH = 12;

/**
 * Where an invitation or reset link lands (ADR-072). Laid out like sign-in.
 * The token never leaves this page except to the API that consumes it.
 */
export default function SetPasswordPage() {
  return (
    <Suspense>
      <SetPasswordForm />
    </Suspense>
  );
}

function SetPasswordForm() {
  const params = useSearchParams();
  const token = params.get('token') ?? '';
  const purpose = params.get('purpose');
  const invite = purpose !== 'reset';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (password.length < MINIMUM_PASSWORD_LENGTH) {
      setError(`The password must be at least ${MINIMUM_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    setSubmitting(true);
    try {
      await api.auth.setPassword(token, password);
      setDone(true);
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
          <h1 className="mt-6 text-display-sm text-content">
            {purpose === 'verify'
              ? 'Confirm your email'
              : invite
                ? 'Welcome to Cartenz'
                : 'Choose a new password'}
          </h1>
          <p className="mt-2 text-body text-content-muted">
            {invite
              ? 'Choose the password you will sign in with.'
              : 'Every other session on this account will be signed out.'}
          </p>
        </div>

        <div className="panel p-6 sm:p-8">
          {!token ? (
            <Alert tone="error">
              This link is incomplete. Open it again from the email, or ask an administrator for a
              new one.
            </Alert>
          ) : done ? (
            <div className="space-y-5">
              <Alert tone="success">
                {purpose === 'verify' ? 'Your email is confirmed and your password is set.' : 'Your password is set.'}
              </Alert>
              <Link href="/login" className="btn-primary h-11 w-full">
                Sign in
              </Link>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-5">
              <div>
                <label htmlFor="password" className="field-label">
                  New password
                </label>
                <input
                  id="password"
                  type="password"
                  autoComplete="new-password"
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="field-input"
                />
                <p className="field-hint">At least {MINIMUM_PASSWORD_LENGTH} characters.</p>
              </div>

              <div>
                <label htmlFor="confirm" className="field-label">
                  Repeat the password
                </label>
                <input
                  id="confirm"
                  type="password"
                  autoComplete="new-password"
                  required
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                  className="field-input"
                />
              </div>

              {error ? <Alert tone="error">{error}</Alert> : null}

              <button type="submit" disabled={submitting} className="btn-primary h-11 w-full">
                {submitting ? <Spinner /> : null}
                {submitting ? 'Saving' : 'Set password'}
              </button>
            </form>
          )}
        </div>

        <p className="mt-12 text-center text-caption text-content-subtle">Cartenz by LinkedERP</p>
      </div>
    </div>
  );
}
