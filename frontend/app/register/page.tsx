'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { ApiError } from '@/lib/api';
import { Spinner } from '@/components/ui/spinner';

const MINIMUM_PASSWORD_LENGTH = 12;

export default function RegisterPage() {
  const { register } = useAuth();
  const [form, setForm] = useState({
    name: '',
    email: '',
    organizationName: '',
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
          <h1 className="text-base font-semibold">Create an account</h1>
          <p className="mt-1 text-xs text-content-muted">
            You will own the organisation you name here. Colleagues can be added afterwards.
          </p>

          <form onSubmit={submit} className="mt-6 space-y-4">
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
                placeholder="you@organisation.com"
              />
            </div>

            <div>
              <label htmlFor="organizationName" className="field-label">
                Organisation name
              </label>
              <input
                id="organizationName"
                required
                value={form.organizationName}
                onChange={update('organizationName')}
                className="field-input"
                placeholder="Acme Manufacturing"
              />
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
              <p className="mt-1.5 text-2xs text-content-subtle">
                At least {MINIMUM_PASSWORD_LENGTH} characters.
              </p>
            </div>

            {error ? (
              <p className="rounded-md border border-state-failure/30 bg-state-failure/10 px-3 py-2 text-xs text-state-failure">
                {error}
              </p>
            ) : null}

            <button type="submit" disabled={submitting} className="btn-primary w-full">
              {submitting ? <Spinner /> : null}
              {submitting ? 'Creating account' : 'Create account'}
            </button>
          </form>

          <p className="mt-5 text-xs text-content-muted">
            Already have an account?{' '}
            <Link href="/login" className="text-accent hover:underline">
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
