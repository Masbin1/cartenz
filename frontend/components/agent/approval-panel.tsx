'use client';

import { useState } from 'react';
import { humanise } from '@/lib/format';
import { Spinner } from '@/components/ui/spinner';
import { StatusDot } from '@/components/ui/status-dot';
import { Disclosure } from '@/components/ui/disclosure';
import type { Approval } from '@/lib/types';

/**
 * Friendly names for approval actions whose raw identifier would read poorly
 * after `humanise`. `chat_edit` is a chat task asking to write a file.
 */
const ACTION_LABELS: Record<string, string> = {
  chat_edit: 'File change',
  odoo_record_write: 'Odoo data change',
};

/**
 * The approval decision.
 *
 * Deliberately explicit: the action being authorised is named, the reason it
 * requires authorisation is shown, and approving and rejecting are separate
 * buttons rather than a single toggle. A note is optional and is recorded on the
 * approval record.
 *
 * When present it is the primary call to action in the workspace, so it reads
 * in a fixed order: what is waiting, what approving it will do (the reason, in
 * body text), then the decision. The raw approval context is technical and sits
 * behind a disclosure, one click away for the reviewer who wants it.
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

  const contextEntries = Object.entries(approval.context);
  const noteId = `approval-note-${approval.id}`;

  return (
    <section
      aria-label="Approval required"
      className="animate-rise-in rounded-card border border-state-waiting/30 bg-surface-raised px-5 py-5 sm:px-6"
    >
      <StatusDot tone="waiting" pulse size="small">
        Awaiting your approval
      </StatusDot>
      <h2 className="mt-2 text-headline text-content">
        {ACTION_LABELS[approval.action] ?? humanise(approval.action)}
      </h2>
      <p className="mt-1.5 max-w-2xl text-body text-content-muted">{approval.requiredReason}</p>

      {contextEntries.length > 0 ? (
        <Disclosure
          className="mt-4"
          summary="Technical details"
          hint={`${contextEntries.length} field${contextEntries.length === 1 ? '' : 's'}`}
        >
          <dl className="space-y-2.5 rounded-xl bg-surface-overlay/60 px-4 py-3">
            {contextEntries.map(([key, value]) => (
              <div key={key} className="min-w-0 sm:flex sm:gap-4">
                <dt className="shrink-0 text-meta text-content-subtle sm:w-36">{humanise(key)}</dt>
                <dd className="mt-0.5 min-w-0 break-words font-mono text-caption text-content-muted sm:mt-0">
                  {Array.isArray(value) ? value.join(', ') : String(value)}
                </dd>
              </div>
            ))}
          </dl>
        </Disclosure>
      ) : null}

      {canDecide ? (
        <div className="mt-5 border-t border-surface-border pt-5">
          <label htmlFor={noteId} className="field-label">
            Note <span className="font-normal text-content-subtle">(optional)</span>
          </label>
          <input
            id={noteId}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Recorded on the approval"
            className="field-input"
          />
          <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void decide('rejected')}
              className="btn-secondary"
            >
              {busy === 'rejected' ? <Spinner className="h-3.5 w-3.5" /> : null}
              Reject
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void decide('approved')}
              className="btn-primary"
            >
              {busy === 'approved' ? <Spinner className="h-3.5 w-3.5" /> : null}
              Approve
            </button>
          </div>
        </div>
      ) : (
        <p className="mt-4 text-meta text-content-subtle">
          Only a developer or above can decide this approval.
        </p>
      )}
    </section>
  );
}
