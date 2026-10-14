'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { Alert } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';
import { CartenzMark } from '@/components/ui/cartenz-mark';

/**
 * Asks for a reset link (ADR-072). The confirmation reads the same whether or
 * not the address has an account, matching what the API answers.
 */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.auth.forgotPassword(email);
      setSent(true);
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
          <h1 className="mt-6 text-display-sm text-content">Forgot your password?</h1>
          <p className="mt-2 text-body text-content-muted">
            We will email you a link to choose a new one.
          </p>
        </div>

        <div className="panel p-6 sm:p-8">
          {sent ? (
            <Alert tone="success">
              If an account uses {email}, a reset link is on its way. It works once and expires in
              an hour. Nothing arrived? Ask an administrator for a link.
            </Alert>
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

              {error ? <Alert tone="error">{error}</Alert> : null}

              <button type="submit" disabled={submitting} className="btn-primary h-11 w-full">
                {submitting ? <Spinner /> : null}
                {submitting ? 'Sending' : 'Send reset link'}
              </button>
            </form>
          )}
        </div>

        <p className="mt-8 text-center text-callout text-content-muted">
          <Link href="/login" className="link">
            Back to sign in
          </Link>
        </p>

        <p className="mt-12 text-center text-caption text-content-subtle">Cartenz by LinkedERP</p>
      </div>
    </div>
  );
}
