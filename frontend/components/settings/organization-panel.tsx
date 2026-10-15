'use client';

import { useEffect, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { Alert } from '@/components/ui/alert';
import { Section } from '@/components/ui/section';
import { SkeletonRows } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';

/**
 * The organisation and the email domains that may hold an account (ADR-072
 * addendum 2). Admin only. Sign-up and invitations refuse any other domain;
 * accounts that already exist are left alone.
 */
export function OrganizationPanel({ id = 'organization' }: { id?: string }) {
  const [form, setForm] = useState<{ name: string; domains: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = (org: { name: string; allowedDomains: string[] }) =>
    setForm({ name: org.name, domains: org.allowedDomains.join('\n') });

  useEffect(() => {
    api.settings
      .organization()
      .then(load)
      .catch((caught) =>
        setError(caught instanceof ApiError ? caught.message : 'The organisation could not be loaded.'),
      );
  }, []);

  const save = async () => {
    if (!form) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      load(
        await api.settings.updateOrganization({
          name: form.name,
          allowedDomains: form.domains.split(/[\s,]+/).filter(Boolean),
        }),
      );
      setNotice('Organisation saved.');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The organisation could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section
      id={id}
      title="Organization"
      description="Who may have an account: only addresses at these email domains can sign up or be invited."
      className="scroll-mt-24 lg:scroll-mt-10"
    >
      <div className="space-y-5">
        {error ? <Alert tone="error">{error}</Alert> : null}
        {notice ? <Alert tone="success">{notice}</Alert> : null}

        {!form ? (
          <div className="panel p-5">
            <SkeletonRows rows={2} />
          </div>
        ) : (
          <div className="panel">
            <div className="panel-body space-y-6 pt-5 sm:pt-6">
              <div>
                <label htmlFor="org-name" className="field-label">
                  Name
                </label>
                <input
                  id="org-name"
                  className="field-input"
                  placeholder="LinkedERP"
                  value={form.name}
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                />
              </div>

              <div>
                <label htmlFor="org-domains" className="field-label">
                  Allowed email domains
                </label>
                <textarea
                  id="org-domains"
                  rows={3}
                  className="field-input font-mono text-callout"
                  placeholder="linkederp.com"
                  value={form.domains}
                  onChange={(event) => setForm({ ...form, domains: event.target.value })}
                />
                <p className="field-hint">
                  One per line. With none, nobody new can sign up or be invited. Sign-up also needs
                  email set up, because each address is confirmed by a link.
                </p>
              </div>

              <div className="border-t border-surface-border pt-5">
                <button type="button" className="btn-primary" onClick={() => void save()} disabled={saving}>
                  {saving ? <Spinner /> : null}
                  Save organization
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </Section>
  );
}
