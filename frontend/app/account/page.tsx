'use client';

import { useState } from 'react';
import { Info } from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { ApiError, api } from '@/lib/api';
import { AppShell } from '@/components/ui/app-shell';
import { PageHeader } from '@/components/ui/page';
import { Section } from '@/components/ui/section';
import { DetailItem, DetailList } from '@/components/ui/detail-list';
import { Alert } from '@/components/ui/alert';
import { PageLoading, Spinner } from '@/components/ui/spinner';
import { USER_REGION_LABELS } from '@/lib/types';
import { NotificationsSection } from '@/components/account/notifications-section';

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
      <div className="page-narrow">
        <PageHeader title="Account" description="Your details, password and notifications." />

        {error || notice ? (
          <div className="mb-10 space-y-3">
            {error ? <Alert tone="error">{error}</Alert> : null}
            {notice ? <Alert tone="success">{notice}</Alert> : null}
          </div>
        ) : null}

        <div className="space-y-12 sm:space-y-16">
          <Section title="Details">
            <DetailList columns={2}>
              <DetailItem label="Name">{user.name}</DetailItem>
              <DetailItem label="Email">{user.email}</DetailItem>
              <DetailItem label="Region">{USER_REGION_LABELS[user.region]}</DetailItem>
              <DetailItem label="Role">{user.isAdmin ? 'Administrator' : 'Member'}</DetailItem>
            </DetailList>
            <p className="mt-6 text-meta text-content-subtle">
              Region and role are access boundaries, so only an administrator can change them.
            </p>
          </Section>

          <Section
            title="Change password"
            description="Changing your password signs out every other device. This one stays signed in."
          >
            <form onSubmit={submit} className="panel space-y-5 p-6 sm:p-8">
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
                <p className="field-hint">At least {MINIMUM_PASSWORD_LENGTH} characters.</p>
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

              <div className="pt-1">
                <button type="submit" disabled={saving} className="btn-primary w-full sm:w-auto">
                  {saving ? <Spinner /> : null}
                  {saving ? 'Changing' : 'Change password'}
                </button>
              </div>
            </form>
          </Section>

          <Section title="Forgotten your password?" size="small" divided>
            <p className="flex items-start gap-3 text-callout text-content-muted">
              <Info
                className="mt-0.5 h-4 w-4 shrink-0 text-content-subtle"
                strokeWidth={1.75}
                aria-hidden="true"
              />
              <span>
                There is no email reset on this deployment yet. Ask an administrator to set a new
                password for you from Users, then change it here once you are signed in.
              </span>
            </p>
          </Section>

          <Section
            title="Notifications"
            description="On by default. Turn them off here if you would rather not be told."
            divided
          >
            <NotificationsSection />
          </Section>
        </div>
      </div>
    </AppShell>
  );
}
