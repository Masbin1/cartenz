'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { ApiError } from '@/lib/api';
import { Alert } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';
import { CartenzMark } from '@/components/ui/cartenz-mark';
import { USER_REGIONS, USER_REGION_LABELS } from '@/lib/types';

const MINIMUM_PASSWORD_LENGTH = 12;

/**
 * Account creation, laid out like sign-in: the mark, one title, one form and
 * one button. Region is asked for here because it decides which projects the
 * new account can see.
 */
export default function RegisterPage() {
  const { register } = useAuth();
  const [form, setForm] = useState({
    name: '',
    email: '',
    region: USER_REGIONS[0] as string,
    password: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const update = (field: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setForm((previous) => ({ ...previous, [field]: event.target.value }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    if (form.password.length < MINIMUM_PASSWORD_LENGTH) {
      setError(`The password must be at least ${MINIMUM_PASSWORD_LENGTH} characters.`);
      return;
    }

    setSubmitting(true);
    try {
      await register(form);
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
          <h1 className="mt-6 text-display-sm text-content">Create your account</h1>
          <p className="mt-2 text-body text-content-muted">
            Choose the region you work in. An administrator can change it later.
          </p>
        </div>

        <div className="panel p-6 sm:p-8">
          <form onSubmit={submit} className="space-y-5">
            <div>
              <label htmlFor="name" className="field-label">
                Full name
              </label>
              <input
                id="name"
                required
                value={form.name}
                onChange={update('name')}
                className="field-input"
                placeholder="Thandi Mokoena"
              />
            </div>

            <div>
              <label htmlFor="email" className="field-label">
                Email address
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={form.email}
                onChange={update('email')}
                className="field-input"
                placeholder="you@example.com"
              />
            </div>

            <div>
              <label htmlFor="region" className="field-label">
                Region
              </label>
              <select
                id="region"
                required
                value={form.region}
                onChange={(event) => setForm((p) => ({ ...p, region: event.target.value }))}
                className="field-input"
              >
                {USER_REGIONS.map((region) => (
                  <option key={region} value={region}>
                    {USER_REGION_LABELS[region]}
                  </option>
                ))}
              </select>
              <p className="field-hint">You will see the projects in this region.</p>
            </div>

            <div>
              <label htmlFor="password" className="field-label">
                Password
              </label>
              <input
                id="password"
                type="password"
                autoComplete="new-password"
                required
                minLength={MINIMUM_PASSWORD_LENGTH}
                value={form.password}
                onChange={update('password')}
                className="field-input"
                placeholder="At least 12 characters"
              />
              <p className="field-hint">At least {MINIMUM_PASSWORD_LENGTH} characters.</p>
            </div>

            {error ? <Alert tone="error">{error}</Alert> : null}

            <button type="submit" disabled={submitting} className="btn-primary h-11 w-full">
              {submitting ? <Spinner /> : null}
              {submitting ? 'Creating account' : 'Create account'}
            </button>
          </form>
        </div>

        <p className="mt-8 text-center text-callout text-content-muted">
          Already have an account?{' '}
          <Link href="/login" className="link">
            Sign in
          </Link>
        </p>

        <p className="mt-12 text-center text-caption text-content-subtle">Cartenz by LinkedERP</p>
      </div>
    </div>
  );
}
