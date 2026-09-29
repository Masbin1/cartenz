'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Alert } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';
import { StatusDot } from '@/components/ui/status-dot';
import { SkeletonText } from '@/components/ui/skeleton';
import { relativeTime } from '@/lib/format';
import type { ConnectedInstanceInfo } from '@/lib/types';

/**
 * A connected odoo.sh project's own instance on this server (ADR-069).
 *
 * The platform stands up an EMPTY Odoo instance — the same chain "Create with
 * AI" runs — reachable over HTTPS with the database manager open. The project
 * owner opens `/web/database/manager` and restores their own odoo.sh backup
 * into it; the platform never loads customer data itself here.
 *
 * Separate from ADR-067's restored copy on purpose: that one is built FROM a
 * staged backup and locked to localhost; this one is public, empty, and the
 * owner fills it. The agent works against neither.
 */
export function ConnectedInstancePanel({
  projectId,
  instance,
  isAdmin,
  onQueued,
}: {
  projectId: string;
  instance: ConnectedInstanceInfo;
  isAdmin: boolean;
  /** Reloads the project, whose `connectedInstance` block the page then polls. */
  onQueued: () => void;
}) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const state = await api.projects.connectedInstanceAvailability(projectId);
      setAvailable(state.available);
      setReason(state.reason);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The instance state could not be read.');
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await api.projects.createConnectedInstance(projectId);
      setMessage(
        `Creating "${result.instanceName}". Cloning the database and issuing the HTTPS ` +
          'certificate takes a few minutes; this page updates on its own.',
      );
      onQueued();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The instance could not be queued.');
    } finally {
      setBusy(false);
    }
  };

  const reveal = async () => {
    setRevealing(true);
    setRevealError(null);
    try {
      const { masterPassword } = await api.projects.revealConnectedInstanceMasterPassword(projectId);
      setRevealed(masterPassword);
    } catch (caught) {
      setRevealError(
        caught instanceof ApiError ? caught.message : 'The master password could not be revealed.',
      );
    } finally {
      setRevealing(false);
    }
  };

  const managerUrl = instance.url ? `${instance.url.replace(/\/+$/, '')}/web/database/manager` : null;

  return (
    <section aria-labelledby="connected-instance-title">
      <div className="min-w-0">
        <h2 id="connected-instance-title" className="text-headline text-content">
          Project instance
        </h2>
        <p className="mt-1 text-callout text-content-muted">
          An empty Odoo instance on this server, on HTTPS, for the project owner to restore their
          own odoo.sh backup into through the database manager. The agent never works here.
        </p>
      </div>

      <div className="mt-4 space-y-3">
        {error ? <Alert tone="error">{error}</Alert> : null}
        {message ? <Alert tone="info">{message}</Alert> : null}

        {instance.status === 'pending' ? (
          <StatusDot tone="running" pulse>
            Creating the instance
          </StatusDot>
        ) : instance.status === 'ready' && instance.url ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <StatusDot tone="success">Running</StatusDot>
              {instance.createdAt ? (
                <span className="text-meta tabular-nums text-content-subtle">
                  Created {relativeTime(instance.createdAt)}
                </span>
              ) : null}
            </div>

            {instance.error ? <Alert tone="warning">{instance.error}</Alert> : null}

            <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <dt className="text-meta text-content-subtle">Link</dt>
                <dd className="mono-meta break-all">
                  <a href={instance.url} target="_blank" rel="noreferrer" className="link">
                    {instance.url}
                  </a>
                </dd>
              </div>
              {managerUrl ? (
                <div className="sm:col-span-2">
                  <dt className="text-meta text-content-subtle">Database manager (restore here)</dt>
                  <dd className="mono-meta break-all">
                    <a href={managerUrl} target="_blank" rel="noreferrer" className="link">
                      {managerUrl}
                    </a>
                  </dd>
                </div>
              ) : null}
              <div>
                <dt className="text-meta text-content-subtle">Instance</dt>
                <dd className="mono-meta break-all">{instance.instanceName}</dd>
              </div>
              <div>
                <dt className="text-meta text-content-subtle">Port</dt>
                <dd className="mono-meta tabular-nums">{instance.port}</dd>
              </div>
            </dl>

            <div className="space-y-2">
              <p className="text-meta text-content-subtle">
                {revealed
                  ? 'Master password — needed by the database manager to restore. Store it safely.'
                  : instance.hasMasterPassword
                    ? isAdmin
                      ? 'The database manager asks for the master password. Held encrypted.'
                      : 'Held encrypted. Only an organisation admin or owner can reveal it.'
                    : 'No master password was recorded; recover it from the instance’s odoo.conf on the server.'}
              </p>
              {!revealed && isAdmin && instance.hasMasterPassword ? (
                <button
                  type="button"
                  onClick={() => void reveal()}
                  disabled={revealing}
                  className="btn-secondary btn-sm"
                >
                  {revealing ? <Spinner className="h-3.5 w-3.5" /> : null}
                  {revealing ? 'Revealing…' : 'Reveal master password'}
                </button>
              ) : null}
              {revealed ? (
                <p className="mono-meta break-all rounded-md bg-surface-raised px-3 py-2 text-content">
                  {revealed}
                </p>
              ) : null}
              {revealError ? <Alert tone="error">{revealError}</Alert> : null}
            </div>
          </div>
        ) : instance.status === 'failed' ? (
          <div className="space-y-2">
            <Alert tone="error">{instance.error ?? 'The instance could not be created.'}</Alert>
            <p className="text-meta text-content-subtle">
              The host may hold a partly built instance
              {instance.instanceName ? ` (${instance.instanceName})` : ''}; an operator removes it
              before a retry can reuse the name.
            </p>
          </div>
        ) : available === null ? (
          <SkeletonText lines={2} />
        ) : !available ? (
          <p className="text-callout text-content-subtle">{reason}</p>
        ) : !isAdmin ? (
          <p className="text-callout text-content-subtle">
            No instance yet. An administrator can create one.
          </p>
        ) : (
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => void create()}
              disabled={busy}
              className="btn-secondary btn-sm w-full sm:w-auto"
            >
              {busy ? <Spinner className="h-3.5 w-3.5" /> : null}
              {busy ? 'Queuing' : 'Create instance'}
            </button>
            <p className="text-meta text-content-subtle">
              Creates a new database from the standard template, a service, an Nginx site and an
              HTTPS certificate on this server, and checks out the project&rsquo;s repository when
              one is connected. Uses memory on this server for as long as it runs.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
