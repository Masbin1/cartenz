'use client';

import { useState } from 'react';
import { humanise } from '@/lib/format';
import { Spinner } from '@/components/ui/spinner';
import type { Approval } from '@/lib/types';

/**
 * The approval decision.
 *
 * Deliberately explicit: the action being authorised is named, the reason it
 * requires authorisation is shown, and approving and rejecting are separate
 * buttons rather than a single toggle. A note is optional and is recorded on the
 * approval record.
 */
export function ApprovalPanel({
  approval,
  onDecide,
  canDecide,
}: {
  approval: Approval;
  onDecide: (decision: 'approved' | 'rejected', note?: string) => Promise<void>;
  canDecide: boolean;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'approved' | 'rejected' | null>(null);

  const decide = async (decision: 'approved' | 'rejected') => {
    setBusy(decision);
    try {
      await onDecide(decision, note.trim().length > 0 ? note.trim() : undefined);
      setNote('');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-md border border-state-waiting/40 bg-state-waiting/10 px-4 py-4">
      <div className="flex items-start gap-2.5">
        <span className="mt-1 h-2 w-2 shrink-0 animate-pulse rounded-full bg-state-waiting" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-state-waiting">
            Approval required: {humanise(approval.action)}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-content-muted">
            {approval.requiredReason}
          </p>

          {Object.keys(approval.context).length > 0 ? (
            <dl className="mt-3 space-y-1">
              {Object.entries(approval.context).map(([key, value]) => (
                <div key={key} className="flex gap-2 text-2xs">
                  <dt className="shrink-0 text-content-subtle">{humanise(key)}</dt>
                  <dd className="min-w-0 break-words font-mono text-content-muted">
                    {Array.isArray(value) ? value.join(', ') : String(value)}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}

          {canDecide ? (
            <div className="mt-4 space-y-2.5">
              <input
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Note (optional, recorded on the approval)"
                className="field-input py-1.5 text-xs"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void decide('approved')}
                  className="btn-primary py-1.5 text-xs"
                >
                  {busy === 'approved' ? <Spinner className="h-3 w-3" /> : null}
                  Approve
                </button>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void decide('rejected')}
                  className="btn-secondary py-1.5 text-xs"
                >
                  {busy === 'rejected' ? <Spinner className="h-3 w-3" /> : null}
                  Reject
                </button>
              </div>
            </div>
          ) : (
            <p className="mt-3 text-2xs text-content-subtle">
              Deciding this approval requires the developer role or above.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
