'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ArrowUpRight, Copy } from 'lucide-react';
import { ApiError, api } from '@/lib/api';
import type { GitCredential } from '@/lib/types';
import { Alert } from '@/components/ui/alert';
import { Section } from '@/components/ui/section';
import {
  ODOO_SH_CREATE_URL,
  odooShFillBookmarklet,
  odooShRegionLabel,
  type OdooShSignup,
} from '@/lib/odoo-sh';

/**
 * Finish an assisted Odoo.sh project (ADR-071): the deploy values to copy into
 * odoo.sh, a link that opens it, and the button that connects the repository
 * Odoo.sh created. The token is a registered Git credential, so nothing secret
 * is typed here.
 */
export function OdooShSetupPanel({
  projectId,
  signup,
  onConnected,
}: {
  projectId: string;
  signup: OdooShSignup;
  onConnected: () => void;
}) {
  const [tokens, setTokens] = useState<GitCredential[] | null>(null);
  const [credentialId, setCredentialId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    void api.settings.gitCredentials().then(({ credentials }) => {
      const usable = credentials.filter(
        (c) =>
          c.enabled &&
          c.credentialKind === 'token' &&
          (c.hosts.length === 0 || c.hosts.includes('github.com')),
      );
      setTokens(usable);
      setCredentialId((usable.find((c) => c.isDefault) ?? usable[0])?.id ?? '');
    });
  }, []);

  const connect = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      await api.projects.connectOdooSh(projectId, credentialId ? { credentialId } : {});
      onConnected();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The repository could not be connected.');
    } finally {
      setSubmitting(false);
    }
  }, [projectId, credentialId, onConnected]);

  const checklist = [
    { label: 'GitHub repository', value: 'New repository' },
    { label: 'Owner', value: signup.owner },
    { label: 'Repository name', value: signup.repositoryName },
    { label: 'Odoo version', value: signup.odooVersion },
    { label: 'Hosting location', value: odooShRegionLabel(signup.region) },
  ];

  const copy = (label: string, value: string) => {
    void navigator.clipboard?.writeText(value);
    setCopied(label);
  };

  return (
    <Section
      title="Finish Odoo.sh setup"
      description="The project is deployed at odoo.sh, which also creates its GitHub repository. Cartenz connects that repository once it exists."
    >
      <div className="space-y-8">
        <ol className="list-decimal space-y-1.5 pl-5 text-callout text-content-muted">
          <li>
            Once: drag <span className="text-content">Fill from Cartenz</span> to your bookmarks bar.
          </li>
          <li>
            Open odoo.sh, then click that bookmark: it fills the form with the values below.
          </li>
          <li>Enter your subscription code there and click Deploy. Cartenz never sees the code.</li>
          <li>Come back and connect the repository.</li>
        </ol>

        <dl className="divide-y divide-border rounded-md border border-border">
          {checklist.map((entry) => (
            <div key={entry.label} className="flex items-center justify-between gap-4 px-4 py-2.5">
              <dt className="text-callout text-content-muted">{entry.label}</dt>
              <dd className="flex items-center gap-2 font-mono text-callout">
                {entry.value}
                <button
                  type="button"
                  className="btn-ghost p-1"
                  onClick={() => copy(entry.label, entry.value)}
                  aria-label={`Copy ${entry.label}`}
                >
                  <Copy className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                </button>
              </dd>
            </div>
          ))}
        </dl>
        {copied ? <p className="text-caption text-content-muted" role="status">Copied {copied}.</p> : null}

        <div className="flex flex-wrap gap-3">
          {/* A bookmarklet: React refuses javascript: hrefs as props, so it is set
              on the DOM node. Clicking it here does nothing; it runs on odoo.sh. */}
          <a
            ref={(node) => node?.setAttribute('href', odooShFillBookmarklet(signup))}
            onClick={(event) => event.preventDefault()}
            className="btn-secondary w-fit cursor-grab"
            title="Drag to your bookmarks bar, then click it on odoo.sh/project/create"
          >
            Fill from Cartenz
          </a>
          {/* A normal tab, not a popup: a popup window has no bookmarks bar. */}
          <a href={ODOO_SH_CREATE_URL} target="_blank" rel="noreferrer" className="btn-primary w-fit">
            Open Odoo.sh
            <ArrowUpRight className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden="true" />
          </a>
        </div>

        <div className="space-y-3">
          {tokens && tokens.length === 0 ? (
            <Alert tone="warning">
              No GitHub access token is registered. Add one in{' '}
              <Link href="/settings#git-credentials" className="underline">Settings → Git credentials</Link>{' '}
              (kind: Access token, host: github.com), with access to the repositories of {signup.owner}.
            </Alert>
          ) : null}
          {tokens && tokens.length > 1 ? (
            <div>
              <label htmlFor="sh-token" className="field-label">GitHub token</label>
              <select
                id="sh-token"
                className="field-input"
                value={credentialId}
                onChange={(event) => setCredentialId(event.target.value)}
              >
                {tokens.map((t) => (
                  <option key={t.id} value={t.id}>{t.label}</option>
                ))}
              </select>
            </div>
          ) : null}
          {error ? <Alert tone="error">{error}</Alert> : null}
          <button type="button" className="btn-primary" onClick={() => void connect()} disabled={submitting}>
            {submitting ? 'Connecting…' : 'I have deployed: connect the repository'}
          </button>
        </div>
      </div>
    </Section>
  );
}
