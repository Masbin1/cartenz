'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { ApiError, api } from '@/lib/api';
import { Alert } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';
import { CartenzMark } from '@/components/ui/cartenz-mark';
import { USER_REGIONS, USER_REGION_LABELS } from '@/lib/types';

const MINIMUM_PASSWORD_LENGTH = 12;

const apiMessage = (caught: unknown) =>
  caught instanceof ApiError ? caught.message : 'Could not reach the API. Check that the backend is running.';

/**
 * Account creation, laid out like sign-in: the mark, one title, one form and
 * one button. Region is asked for here because it decides which projects the
 * new account can see. The first account types a password and becomes admin.
 * After it, anyone from an allowed email domain signs up here, then types the
 * 6-digit code from the mail (or opens its link) and chooses a password. The
 * mail is what proves the inbox exists (ADR-072 addenda 2 and 3).
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
  const [open, setOpen] = useState(true);
  const [firstAccount, setFirstAccount] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    api.auth
      .registration()
      .then((answer) => {
        setOpen(answer.open);
        setFirstAccount(answer.firstAccount);
      })
      .catch(() => undefined);
  }, []);

  const update = (field: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setForm((previous) => ({ ...previous, [field]: event.target.value }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    if (firstAccount && form.password.length < MINIMUM_PASSWORD_LENGTH) {
      setError(`The password must be at least ${MINIMUM_PASSWORD_LENGTH} characters.`);
      return;
    }

    setSubmitting(true);
    try {
      const { password: _password, ...rest } = form;
      if ((await register(firstAccount ? form : rest)) === 'pending') setPending(true);
    } catch (caught) {
      setError(apiMessage(caught));
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
            {pending ? 'Check your email' : 'Create your account'}
          </h1>
          <p className="mt-2 text-body text-content-muted">
            {pending
              ? `If ${form.email} can have an account here, a 6-digit code is on its way.`
              : 'Choose the region you work in. An administrator can change it later.'}
          </p>
        </div>

        <div className="panel p-6 sm:p-8">
          {pending ? (
            <VerifyCodeForm email={form.email} />
          ) : !open ? (
            <Alert tone="info">
              Sign-up is not available right now. Ask an administrator for an invitation; it arrives
              by email with a link to choose your password.
            </Alert>
          ) : (
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
                {!firstAccount ? (
                  <p className="field-hint">Use your work address. We send a code to confirm it.</p>
                ) : null}
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

              {firstAccount ? (
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
              ) : null}

              {error ? <Alert tone="error">{error}</Alert> : null}

              <button type="submit" disabled={submitting} className="btn-primary h-11 w-full">
                {submitting ? <Spinner /> : null}
                {submitting ? 'Creating account' : 'Create account'}
              </button>
            </form>
          )}
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

/**
 * The second step of sign-up: the code from the mail and the password, in the
 * tab the person already has open. The mail's link does the same from another
 * device. Resending is limited server-side to once per two minutes.
 */
function VerifyCodeForm({ email }: { email: string }) {
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<'verify' | 'resend' | null>(null);
  const [done, setDone] = useState(false);
  const [resendIn, setResendIn] = useState(120);

  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = setTimeout(() => setResendIn((seconds) => seconds - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendIn]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setNotice(null);
    if (password.length < MINIMUM_PASSWORD_LENGTH) {
      setError(`The password must be at least ${MINIMUM_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    setBusy('verify');
    try {
      await api.auth.verifyCode(email, code, password);
      setDone(true);
    } catch (caught) {
      setError(apiMessage(caught));
    } finally {
      setBusy(null);
    }
  };

  const resend = async () => {
    setError(null);
    setNotice(null);
    setBusy('resend');
    try {
      await api.auth.resendVerification(email);
      setCode('');
      setResendIn(120);
      setNotice('A new code is on its way. Earlier codes and links no longer work.');
    } catch (caught) {
      setError(apiMessage(caught));
    } finally {
      setBusy(null);
    }
  };

  if (done) {
    return (
      <div className="space-y-5">
        <Alert tone="success">Your email is confirmed and your password is set.</Alert>
        <Link href="/login" className="btn-primary h-11 w-full">
          Sign in
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <div>
        <label htmlFor="code" className="field-label">
          Code from the email
        </label>
        <input
          id="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          required
          pattern="\d{6}"
          maxLength={6}
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
          className="field-input text-center font-mono text-title tracking-[0.5em]"
          placeholder="000000"
        />
        <p className="field-hint">Or open the link in the email, on any device. Both expire in 24 hours.</p>
      </div>

      <div>
        <label htmlFor="new-password" className="field-label">
          Choose a password
        </label>
        <input
          id="new-password"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="field-input"
          placeholder="At least 12 characters"
        />
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
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <button type="submit" disabled={busy !== null} className="btn-primary h-11 w-full">
        {busy === 'verify' ? <Spinner /> : null}
        {busy === 'verify' ? 'Confirming' : 'Confirm and continue'}
      </button>

      <p className="text-center text-callout text-content-muted">
        No email? Check the spam folder, or{' '}
        <button
          type="button"
          className="link"
          onClick={() => void resend()}
          disabled={busy !== null || resendIn > 0}
        >
          {resendIn > 0 ? `send a new code in ${resendIn}s` : 'send a new code'}
        </button>
        .
      </p>
    </form>
  );
}
