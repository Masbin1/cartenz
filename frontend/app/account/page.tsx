'use client';

import { useState } from 'react';
import { useRequireAuth } from '@/lib/auth';
import { ApiError, api } from '@/lib/api';
import { AppShell } from '@/components/ui/app-shell';
import { Alert } from '@/components/ui/alert';
import { PageLoading, Spinner } from '@/components/ui/spinner';
import { USER_REGION_LABELS } from '@/lib/types';

const MINIMUM_PASSWORD_LENGTH = 12;

/**
 * Your own account, and the one thing only you can change about it.
 *
 * Region and the admin flag are deliberately read-only here: they are access
 * boundaries, and an account that could widen its own reach would make the
 * boundary decorative. Those live in Users, where an admin sets them.
 */
export default function AccountPage() {
  const { loading, user } = useRequireAuth();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setNotice(null);

    // Checked here as well as on the server: the mismatch is a typing mistake,
    // and a round trip to be told so is a worse way to find out.
    if (newPassword !== confirmPassword) {
      setError('The new password and its confirmation do not match.');
      return;
    }

    if (newPassword.length < MINIMUM_PASSWORD_LENGTH) {
      setError(`The new password must be at least ${MINIMUM_PASSWORD_LENGTH} characters.`);
      return;
    }

    setSaving(true);
    try {
      await api.auth.changePassword({ currentPassword, newPassword });
      setNotice(
        'Your password was changed. Any other device signed in as you has been signed out.',
      );
      reset();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The password could not be changed.');
    } finally {
      setSaving(false);
    }
  };

  if (loading || !user) return <PageLoading label="Loading account" />;

  return (
    <AppShell>
      <header className="mb-6">
        <h1 className="text-lg font-semibold">Account</h1>
        <p className="mt-1 text-xs text-content-muted">Your own details and password.</p>
      </header>

      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <section className="panel">
        <div className="panel-header">
          <h2 className="panel-title">Details</h2>
        </div>

        <dl className="grid gap-3 px-4 py-4 sm:grid-cols-2">
          <div>
            <dt className="text-2xs uppercase tracking-wide text-content-subtle">Name</dt>
            <dd className="mt-0.5 text-xs">{user.name}</dd>
          </div>
          <div>
            <dt className="text-2xs uppercase tracking-wide text-content-subtle">Email</dt>
            <dd className="mt-0.5 truncate text-xs">{user.email}</dd>
          </div>
          <div>
            <dt className="text-2xs uppercase tracking-wide text-content-subtle">Region</dt>
            <dd className="mt-0.5 text-xs">{USER_REGION_LABELS[user.region]}</dd>
          </div>
          <div>
            <dt className="text-2xs uppercase tracking-wide text-content-subtle">Role</dt>
            <dd className="mt-0.5 text-xs">{user.isAdmin ? 'Administrator' : 'Member'}</dd>
          </div>
        </dl>

        <p className="border-t border-surface-border px-4 py-3 text-2xs text-content-subtle">
          Region and role are access boundaries, so only an administrator can change them.
        </p>
      </section>

      <section className="panel mt-5">
        <div className="panel-header">
          <h2 className="panel-title">Change password</h2>
        </div>

        <form onSubmit={submit} className="max-w-sm space-y-4 px-4 py-4">
          <div>
            <label htmlFor="current-password" className="field-label">
              Current password
            </label>
            <input
              id="current-password"
              type="password"
              autoComplete="current-password"
              required
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              disabled={saving}
              className="field-input"
            />
          </div>

          <div>
            <label htmlFor="new-password" className="field-label">
              New password
            </label>
            <input
              id="new-password"
              type="password"
              autoComplete="new-password"
              required
              minLength={MINIMUM_PASSWORD_LENGTH}
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              disabled={saving}
              className="field-input"
            />
            <p className="mt-1.5 text-2xs text-content-subtle">
              At least {MINIMUM_PASSWORD_LENGTH} characters.
            </p>
          </div>

          <div>
            <label htmlFor="confirm-password" className="field-label">
              Confirm new password
            </label>
            <input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              required
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              disabled={saving}
              className="field-input"
            />
          </div>

          <div className="rounded-md border border-surface-border bg-surface-raised px-3 py-2">
            <p className="text-2xs text-content-muted">
              Changing your password signs out every other device. This one stays signed in.
            </p>
          </div>

          <button type="submit" disabled={saving} className="btn-primary">
            {saving ? <Spinner /> : null}
            {saving ? 'Changing' : 'Change password'}
          </button>
        </form>
      </section>

      <section className="panel mt-5">
        <div className="panel-header">
          <h2 className="panel-title">Forgotten your password?</h2>
        </div>
        <div className="px-4 py-4">
          <p className="text-2xs text-content-muted">
            There is no email reset on this deployment yet. Ask an administrator to set a new
            password for you from the Users screen, then change it here once you are signed in.
          </p>
        </div>
      </section>
    </AppShell>
  );
}
