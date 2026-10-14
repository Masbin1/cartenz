'use client';

import { useEffect, useState } from 'react';
import { ApiError, api, type MailSettings } from '@/lib/api';
import { Alert } from '@/components/ui/alert';
import { Section } from '@/components/ui/section';
import { SkeletonRows } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';

/** The form's own shape: strings for inputs, so an empty field reads as cleared. */
interface MailForm {
  smtpHost: string;
  smtpPort: string;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPassword: string;
  mailFrom: string;
  portalUrl: string;
}

const formFrom = (settings: MailSettings): MailForm => ({
  smtpHost: settings.smtpHost ?? '',
  smtpPort: settings.smtpPort ? String(settings.smtpPort) : '',
  smtpSecure: settings.smtpSecure,
  smtpUser: settings.smtpUser ?? '',
  smtpPassword: '',
  mailFrom: settings.mailFrom ?? '',
  portalUrl: settings.portalUrl ?? '',
});

/**
 * Outgoing mail for invitations and password resets, and the portal address
 * their links point at (ADR-072). Admin only. A saved host here wins over the
 * server's SMTP_URL; with none, the environment applies.
 *
 * The password field is write-only: it starts empty, and leaving it empty keeps
 * whatever is stored. The server never sends the stored value back.
 */
export function MailSettingsPanel({ id = 'email' }: { id?: string }) {
  const [settings, setSettings] = useState<MailSettings | null>(null);
  const [form, setForm] = useState<MailForm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);

  useEffect(() => {
    api.settings
      .mailSettings()
      .then((loaded) => {
        setSettings(loaded);
        setForm(formFrom(loaded));
      })
      .catch((caught) =>
        setError(caught instanceof ApiError ? caught.message : 'The mail settings could not be loaded.'),
      );
  }, []);

  const set = <K extends keyof MailForm>(key: K, value: MailForm[K]) =>
    setForm((current) => (current ? { ...current, [key]: value } : current));

  const save = async () => {
    if (!form) return;
    setBusy('save');
    setError(null);
    setNotice(null);
    try {
      const saved = await api.settings.updateMailSettings({
        smtpHost: form.smtpHost,
        smtpPort: form.smtpPort ? Number(form.smtpPort) : null,
        smtpSecure: form.smtpSecure,
        smtpUser: form.smtpUser,
        ...(form.smtpPassword ? { smtpPassword: form.smtpPassword } : {}),
        mailFrom: form.mailFrom,
        portalUrl: form.portalUrl,
      });
      setSettings(saved);
      setForm(formFrom(saved));
      setNotice('Mail settings saved. Send a test email to check them.');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The mail settings could not be saved.');
    } finally {
      setBusy(null);
    }
  };

  const removePassword = async () => {
    setBusy('save');
    setError(null);
    setNotice(null);
    try {
      const saved = await api.settings.updateMailSettings({ smtpPassword: '' });
      setSettings(saved);
      setForm(formFrom(saved));
      setNotice('The stored SMTP password was removed.');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The password could not be removed.');
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy('test');
    setError(null);
    setNotice(null);
    try {
      await api.settings.testMail();
      setNotice('A test email was sent to your address. Check the inbox, and the spam folder.');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The test email could not be sent.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section
      id={id}
      title="Email"
      description="How invitations and password-reset links are sent, and the portal address they open."
      className="scroll-mt-24 lg:scroll-mt-10"
    >
      <div className="space-y-5">
        {error ? <Alert tone="error">{error}</Alert> : null}
        {notice ? <Alert tone="success">{notice}</Alert> : null}

        {settings?.smtpFromEnvironment ? (
          <Alert tone="info" title="Using the server's environment configuration">
            {settings.mailEnabled
              ? 'No SMTP host is set here, so SMTP_URL from the server is in force. Saving a host here takes over from it.'
              : 'No SMTP host is set here or on the server, so mail is off. Invitation and reset links are still created; copy them from the Users page.'}
          </Alert>
        ) : null}

        {!form ? (
          <div className="panel p-5">
            <SkeletonRows rows={4} />
          </div>
        ) : (
          <div className="panel">
            <div className="panel-body space-y-6 pt-5 sm:pt-6">
              <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_120px]">
                <div>
                  <label htmlFor="smtp-host" className="field-label">
                    SMTP host
                  </label>
                  <input
                    id="smtp-host"
                    className="field-input font-mono text-callout"
                    placeholder="smtp.gmail.com"
                    value={form.smtpHost}
                    onChange={(event) => set('smtpHost', event.target.value)}
                  />
                  <p className="field-hint">Leave blank to use SMTP_URL from the server.</p>
                </div>
                <div>
                  <label htmlFor="smtp-port" className="field-label">
                    Port
                  </label>
                  <input
                    id="smtp-port"
                    inputMode="numeric"
                    className="field-input font-mono text-callout"
                    placeholder={form.smtpSecure ? '465' : '587'}
                    value={form.smtpPort}
                    onChange={(event) => set('smtpPort', event.target.value.replace(/\D/g, ''))}
                  />
                </div>
              </div>

              <fieldset>
                <legend className="field-label">Encryption</legend>
                <div className="flex flex-col gap-2 sm:flex-row sm:gap-6">
                  <label className="flex cursor-pointer items-center gap-2 text-callout text-content">
                    <input
                      type="radio"
                      name="smtp-secure"
                      checked={form.smtpSecure}
                      onChange={() => set('smtpSecure', true)}
                    />
                    SSL/TLS (usually port 465)
                  </label>
                  <label className="flex cursor-pointer items-center gap-2 text-callout text-content">
                    <input
                      type="radio"
                      name="smtp-secure"
                      checked={!form.smtpSecure}
                      onChange={() => set('smtpSecure', false)}
                    />
                    STARTTLS (usually port 587)
                  </label>
                </div>
              </fieldset>

              <div className="grid gap-5 sm:grid-cols-2">
                <div>
                  <label htmlFor="smtp-user" className="field-label">
                    Username
                  </label>
                  <input
                    id="smtp-user"
                    autoComplete="off"
                    className="field-input"
                    placeholder="no-reply@linkederp.com"
                    value={form.smtpUser}
                    onChange={(event) => set('smtpUser', event.target.value)}
                  />
                </div>
                <div>
                  <label htmlFor="smtp-password" className="field-label">
                    Password
                  </label>
                  <input
                    id="smtp-password"
                    type="password"
                    autoComplete="new-password"
                    className="field-input"
                    placeholder={settings?.hasPassword ? 'Stored. Type to replace it.' : ''}
                    value={form.smtpPassword}
                    onChange={(event) => set('smtpPassword', event.target.value)}
                  />
                  <p className="field-hint">
                    Stored encrypted and never shown again.
                    {settings?.hasPassword ? (
                      <button
                        type="button"
                        onClick={() => void removePassword()}
                        disabled={busy !== null}
                        className="link ml-1.5"
                      >
                        Remove it
                      </button>
                    ) : null}
                  </p>
                </div>
              </div>

              <div>
                <label htmlFor="mail-from" className="field-label">
                  From
                </label>
                <input
                  id="mail-from"
                  className="field-input"
                  placeholder="Cartenz <no-reply@linkederp.com>"
                  value={form.mailFrom}
                  onChange={(event) => set('mailFrom', event.target.value)}
                />
                <p className="field-hint">
                  Most providers only accept a From address the username is allowed to send as.
                </p>
              </div>

              <div>
                <label htmlFor="portal-url" className="field-label">
                  Portal URL
                </label>
                <input
                  id="portal-url"
                  className="field-input font-mono text-callout"
                  placeholder={settings?.effectivePortalUrl ?? 'https://cartenz.example.com'}
                  value={form.portalUrl}
                  onChange={(event) => set('portalUrl', event.target.value)}
                />
                <p className="field-hint">
                  The address links in emails and notifications open.
                  {!form.portalUrl && settings?.effectivePortalUrl
                    ? ` Blank uses the server's: ${settings.effectivePortalUrl}.`
                    : ''}
                </p>
              </div>

              <div className="flex flex-col gap-3 border-t border-surface-border pt-5 sm:flex-row sm:items-center">
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => void save()}
                  disabled={busy !== null}
                >
                  {busy === 'save' ? <Spinner /> : null}
                  Save mail settings
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => void test()}
                  disabled={busy !== null || !settings?.mailEnabled}
                >
                  {busy === 'test' ? <Spinner /> : null}
                  Send test email
                </button>
                <span className="meta">The test uses the saved settings, so save first.</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </Section>
  );
}
