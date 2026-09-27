'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Alert } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';
import { StatusDot } from '@/components/ui/status-dot';
import { SkeletonText } from '@/components/ui/skeleton';
import { relativeTime } from '@/lib/format';
import type { RestoredInstanceInfo } from '@/lib/types';

/**
 * The restored copy of a connected odoo.sh project (ADR-067).
 *
 * An operator downloads a backup from odoo.sh, copies it into the platform's
 * staging directory on the host, and picks it here: the platform builds a NEW
 * Odoo instance and loads the backup into it, neutralizing mail, cron and
 * payments before it starts.
 *
 * The panel says out loud what the instance is for, because the distinction is
 * the whole point of the feature and is easy to misread: this copy holds the
 * customer's real data and is there for a person to look at and check work
 * against. The agent never runs against it — tasks keep running on the
 * project's own standard database, which stays empty of customer data. Putting
 * that on screen is what stops "connect an existing project" from reading as
 * "let the agent loose on production".
 *
 * Offered only when a backup exists to restore and the API reports it can:
 * a disabled button whose only outcome is a 403 reads like a bug.
 */
export function RestoredInstancePanel({
  projectId,
  restored,
  isAdmin,
  onQueued,
}: {
  projectId: string;
  restored: RestoredInstanceInfo;
  isAdmin: boolean;
  /** Reloads the project, whose `restoredInstance` block the page then polls. */
  onQueued: () => void;
}) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [backups, setBackups] = useState<readonly string[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const state = await api.projects.restoreBackups(projectId);
      setAvailable(state.available);
      setReason(state.reason);
      setBackups(state.backups);
      // Default to the only staged backup when there is exactly one: the common
      // case is a single zip, and a select with one option and nothing chosen
      // is a pointless extra click.
      setSelected((current) =>
        current && state.backups.includes(current) ? current : (state.backups[0] ?? ''),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The restore state could not be read.');
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const restore = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await api.projects.restoreFromBackup(projectId, selected);
      setMessage(
        `Building "${result.instanceName}" from ${selected}. Loading a real database takes a few minutes.`,
      );
      onQueued();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The restore could not be queued.');
    } finally {
      setBusy(false);
    }
  };

  // An instance that exists is worth showing whoever can see the project; only
  // asking for one is admin-gated, matching the API.
  if (restored.status === 'none' && available === false) {
    return (
      <Section>
        <p className="text-callout text-content-subtle">{reason}</p>
      </Section>
    );
  }

  return (
    <section aria-labelledby="restored-instance-title">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="restored-instance-title" className="text-headline text-content">
            Restored copy of the odoo.sh instance
          </h2>
          <p className="mt-1 text-callout text-content-muted">
            A separate instance on this server, loaded from a backup you downloaded from odoo.sh.
            For you to look at real data — the agent never works here. Tasks run on this
            project&rsquo;s own database, which holds no customer data.
          </p>
        </div>
      </div>

      <div className="mt-4 space-y-3">
        {error ? <Alert tone="error">{error}</Alert> : null}
        {message ? <Alert tone="info">{message}</Alert> : null}

        {restored.status === 'pending' ? (
          <StatusDot tone="running" pulse>
            Building the restored instance
          </StatusDot>
        ) : restored.status === 'failed' ? (
          <Alert tone="error">{restored.error ?? 'The restore could not be built.'}</Alert>
        ) : restored.status === 'restored' && restored.port ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <StatusDot tone="success">Running</StatusDot>
              {restored.restoredAt ? (
                <span className="text-meta tabular-nums text-content-subtle">
                  Built {relativeTime(restored.restoredAt)}
                </span>
              ) : null}
            </div>
            {/*
              Deliberately not a link. The instance holds the customer's real
              data and listens on 127.0.0.1 only, so there is no URL a browser
              could open from here — an anchor would be a dead end that reads
              like a bug. The tunnel is the access path, so it is shown as the
              command it is.
            */}
            <p className="text-callout text-content-muted">
              It listens on this server only. Reach it through a tunnel:
            </p>
            <p className="mono-meta break-all rounded-md bg-surface-raised px-3 py-2 text-content">
              ssh -N -L {restored.port}:127.0.0.1:{restored.port} &lt;user&gt;@&lt;server&gt;
            </p>
            <p className="text-meta text-content-subtle">
              then open http://localhost:{restored.port}
            </p>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
              <div>
                <dt className="text-meta text-content-subtle">Instance</dt>
                <dd className="mono-meta break-all">{restored.instanceName}</dd>
              </div>
              <div>
                <dt className="text-meta text-content-subtle">Port</dt>
                <dd className="mono-meta tabular-nums">{restored.port}</dd>
              </div>
              {restored.backupFile ? (
                <div className="sm:col-span-2">
                  <dt className="text-meta text-content-subtle">Loaded from</dt>
                  <dd className="mono-meta break-all">{restored.backupFile}</dd>
                </div>
              ) : null}
            </dl>
          </div>
        ) : available === null ? (
          <SkeletonText lines={2} />
        ) : !available ? (
          <p className="text-callout text-content-subtle">{reason}</p>
        ) : backups.length === 0 ? (
          <div className="space-y-2">
            <p className="text-callout text-content-subtle">
              No backup is staged. Download the odoo.sh backup and copy the zip to the server:
            </p>
            <p className="mono-meta break-all text-content-muted">
              scp &lt;backup&gt;.zip &lt;user&gt;@&lt;server&gt;:/opt/cartenz/restore-staging/
            </p>
            <p className="text-meta text-content-subtle">
              Then reload this page — the zip appears here.
            </p>
          </div>
        ) : !isAdmin ? (
          <p className="text-callout text-content-subtle">
            {backups.length} backup{backups.length === 1 ? '' : 's'} staged. An administrator can
            build the restored copy.
          </p>
        ) : (
          <div className="space-y-2">
            <label htmlFor="restored-backup" className="block text-meta text-content-subtle">
              Backup to load
            </label>
            <select
              id="restored-backup"
              value={selected}
              onChange={(event) => setSelected(event.target.value)}
              className="input w-full"
            >
              {backups.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void restore()}
              disabled={busy || !selected}
              className="btn-secondary btn-sm w-full sm:w-auto"
            >
              {busy ? <Spinner className="h-3.5 w-3.5" /> : null}
              {busy ? 'Queuing' : 'Build restored copy'}
            </button>
            <p className="text-meta text-content-subtle">
              Builds a new instance and database on this server, neutralizes it (no outbound mail,
              scheduled jobs or payment providers), then leaves it running for you to inspect.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

function Section({ children }: { children: React.ReactNode }) {
  return (
    <section aria-labelledby="restored-instance-title">
      <h2 id="restored-instance-title" className="text-headline text-content">
        Restored copy of the odoo.sh instance
      </h2>
      <div className="mt-2">{children}</div>
    </section>
  );
}
