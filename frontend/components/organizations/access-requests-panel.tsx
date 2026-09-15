'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { Alert } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';
import { relativeTime } from '@/lib/format';
import type { PendingAccessRequest } from '@/lib/types';

/**
 * People waiting for access to a project (ADR-043).
 *
 * One list across every project, because the person deciding opens this page to
 * ask "is anyone waiting", not to audit a particular project.
 *
 * There is no notification behind this panel deliberately: one organisation, few
 * people, and a request that waits an hour costs nothing. The count here is the
 * whole mechanism until a request is seen getting stuck.
 */
export function AccessRequestsPanel({ organizationId }: { organizationId: string }) {
  const [requests, setRequests] = useState<PendingAccessRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setRequests(await api.access.pendingRequests(organizationId));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Requests could not be loaded.');
    }
  }, [organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (row: PendingAccessRequest, decision: 'approved' | 'rejected') => {
    setBusyId(row.id);
    setError(null);
    try {
      await api.access.decide(row.projectId, row.id, decision);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The decision could not be saved.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="panel mt-5">
      <div className="panel-header">
        <h2 className="panel-title">Access requests</h2>
        <span className="text-2xs text-content-subtle">{requests?.length ?? 0}</span>
      </div>

      <div className="space-y-4 px-4 py-4">
        {error ? <Alert tone="error">{error}</Alert> : null}

        {requests === null ? (
          <div className="flex items-center gap-2 text-2xs text-content-subtle">
            <Spinner /> Loading requests
          </div>
        ) : requests.length === 0 ? (
          <p className="text-2xs text-content-subtle">Nobody is waiting for access.</p>
        ) : (
          <ul className="divide-y divide-surface-border rounded border border-surface-border">
            {requests.map((row) => {
              const rowBusy = busyId === row.id;

              return (
                <li key={row.id} className="flex flex-wrap items-start gap-3 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium">
                      {row.userName || row.userEmail} · {row.projectName}
                    </p>
                    <p className="truncate text-2xs text-content-subtle">
                      {row.userEmail} · {relativeTime(row.createdAt)}
                    </p>
                    {row.reason ? (
                      <p className="mt-1 text-2xs text-content-muted">{row.reason}</p>
                    ) : null}
                  </div>

                  <div className="flex shrink-0 items-center gap-3">
                    <button
                      type="button"
                      disabled={rowBusy}
                      onClick={() => void decide(row, 'approved')}
                      className="text-2xs text-content-subtle underline hover:text-content disabled:opacity-40"
                    >
                      {rowBusy ? <Spinner /> : 'Approve'}
                    </button>
                    <button
                      type="button"
                      disabled={rowBusy}
                      onClick={() => void decide(row, 'rejected')}
                      className="text-2xs text-content-subtle underline hover:text-state-failure disabled:opacity-40"
                    >
                      Reject
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
