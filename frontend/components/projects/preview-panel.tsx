'use client';

import { useCallback, useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { api } from '@/lib/api';
import { Alert } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';
import { StatusDot } from '@/components/ui/status-dot';
import { SkeletonText } from '@/components/ui/skeleton';
import type { ProjectPreviewState } from '@/lib/types';

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * The ephemeral preview control (ADR-052).
 *
 * Offered beside the draft diff: it builds a short-lived running Odoo from the
 * task's retained draft so the reviewer sees the real UI before approving. It is
 * an explicit action — it costs a database and a process — and the preview runs
 * on the standard baseline, never the customer's data, which the panel states
 * plainly.
 *
 * Status comes first as a dot and a word; once the instance is ready, opening it
 * is the one prominent action. The branch and the remaining time are secondary.
 */
export function PreviewPanel({
  projectId,
  taskId,
  hasDiff,
}: {
  projectId: string;
  taskId: string;
  hasDiff: boolean;
}) {
  const [state, setState] = useState<ProjectPreviewState | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      setState(await api.projects.preview(projectId));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The preview state could not be read.');
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load, taskId]);

  // A one-second tick drives the countdown and, once the time is up, a refresh
  // that lets the server report the preview as gone.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (state?.preview && state.preview.ttlRemainingMs <= 0) void load();
  }, [now, state, load]);

  const start = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await api.projects.startPreview(projectId, taskId);
      setMessage(result.message);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The preview could not be started.');
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.projects.stopPreview(projectId);
      setMessage('The preview instance was torn down.');
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The preview could not be stopped.');
    } finally {
      setBusy(false);
    }
  };

  const preview = state?.preview ?? null;
  const remaining = preview ? Math.max(0, preview.expiresAt ? Date.parse(preview.expiresAt) - now : preview.ttlRemainingMs) : 0;

  return (
    <section aria-labelledby="preview-title">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="preview-title" className="text-headline text-content">
            Preview
          </h2>
          <p className="mt-1 text-callout text-content-muted">
            A draft instance on standard data, never the customer&rsquo;s.
          </p>
        </div>
        {state?.available && preview?.status === 'ready' ? (
          <button type="button" onClick={() => void stop()} disabled={busy} className="btn-ghost btn-sm shrink-0">
            Stop preview
          </button>
        ) : null}
      </div>

      <div className="mt-4 space-y-3">
        {error ? <Alert tone="error">{error}</Alert> : null}
        {message ? <Alert tone="info">{message}</Alert> : null}

        {!state ? (
          <SkeletonText lines={2} />
        ) : !state.available ? (
          <p className="text-callout text-content-subtle">{state.reason}</p>
        ) : preview?.status === 'creating' ? (
          <StatusDot tone="running" pulse>
            Building the preview instance
          </StatusDot>
        ) : preview?.status === 'failed' ? (
          <Alert tone="error">{preview.error ?? 'The preview could not be built.'}</Alert>
        ) : preview?.status === 'ready' && preview.url ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <StatusDot tone="success">Running</StatusDot>
              <span className="text-meta tabular-nums text-content-subtle">
                Tears down in {formatRemaining(remaining)}
              </span>
            </div>
            <a
              href={preview.url}
              target="_blank"
              rel="noreferrer"
              className="btn-primary btn-sm w-full sm:w-auto"
            >
              Open preview
              <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
            </a>
            <p className="mono-meta break-all">{preview.branch}</p>
          </div>
        ) : hasDiff ? (
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => void start()}
              disabled={busy}
              className="btn-secondary btn-sm w-full sm:w-auto"
            >
              {busy ? <Spinner className="h-3.5 w-3.5" /> : null}
              {busy ? 'Building' : 'Build preview'}
            </button>
            <p className="text-meta text-content-subtle">
              Starts a real Odoo for this task&rsquo;s draft, on the standard database.
            </p>
          </div>
        ) : (
          <p className="text-callout text-content-subtle">
            A preview is offered once this task has a draft diff to show.
          </p>
        )}
      </div>
    </section>
  );
}
