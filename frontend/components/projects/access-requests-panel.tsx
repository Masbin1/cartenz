'use client';

import { useCallback, useEffect, useState } from 'react';
import { UserCheck } from 'lucide-react';
import { ApiError, api } from '@/lib/api';
import { Alert } from '@/components/ui/alert';
import { EmptyState } from '@/components/ui/empty-state';
import { Section } from '@/components/ui/section';
import { SkeletonRows } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { relativeTime } from '@/lib/format';
import type { PendingAccessRequest } from '@/lib/types';

/**
 * People waiting for access to a project (ADR-043).
 *
 * One list across every project, because the person deciding opens this page to
 * ask "is anyone waiting", not to audit a particular project.
 *
 * There is no notification behind this panel deliberately: few people, and a
 * request that waits an hour costs nothing. The count here is the whole
 * mechanism until a request is seen getting stuck.
 *
 * Rendered as an open section of the page it sits on: the requester and the
 * project lead each row, the reason and the time recede, and the decision sits
 * on the right (below on a phone) as one primary and one quiet action.
 */
export function AccessRequestsPanel({ id = 'access-requests' }: { id?: string }) {
  const [requests, setRequests] = useState<PendingAccessRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setRequests(await api.access.pendingRequests());
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Requests could not be loaded.');
    }
  }, []);

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

  const count = requests?.length ?? 0;

  return (
    <Section
      id={id}
      title="Access requests"
      description="Everyone waiting to join a project, across all projects."
      actions={
        requests !== null && count > 0 ? (
          <span className="meta">{count === 1 ? '1 waiting' : `${count} waiting`}</span>
        ) : null
      }
    >
      <div className="space-y-4">
        {error ? <Alert tone="error">{error}</Alert> : null}

        {requests === null ? (
          error ? null : <SkeletonRows rows={2} className="-mx-4" />
        ) : requests.length === 0 ? (
          <div className="rounded-card border border-dashed border-surface-border">
            <EmptyState
              compact
              icon={UserCheck}
              title="Nobody is waiting"
              description="Requests to join a project appear here for you to approve or reject."
            />
          </div>
        ) : (
          <ul className="-mx-4 space-y-1">
            {requests.map((row) => {
              const rowBusy = busyId === row.id;

              return (
                <li
                  key={row.id}
                  className="list-row flex-col items-stretch gap-3 sm:flex-row sm:items-start"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-body font-medium text-content">
                      <span className="break-words">{row.userName || row.userEmail}</span>
                      <span className="text-content-subtle"> wants access to </span>
                      <span className="break-words">{row.projectName}</span>
                    </p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-meta text-content-subtle">
                      <span className="truncate">{row.userEmail}</span>
                      <span aria-hidden="true">·</span>
                      <span className="whitespace-nowrap">{relativeTime(row.createdAt)}</span>
                    </p>
                    {row.reason ? (
                      <p className="mt-2 max-w-2xl text-callout text-content-muted">{row.reason}</p>
                    ) : null}
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      disabled={rowBusy}
                      onClick={() => void decide(row, 'approved')}
                      className="btn-primary btn-sm"
                    >
                      {rowBusy ? <Spinner className="h-3.5 w-3.5" /> : null}
                      Approve
                    </button>
                    <button
                      type="button"
                      disabled={rowBusy}
                      onClick={() => void decide(row, 'rejected')}
                      className="btn-ghost btn-sm"
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
    </Section>
  );
}
