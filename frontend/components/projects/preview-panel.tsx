'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Alert } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';
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
    <div className="panel">
      <div className="panel-header">
        <div className="flex items-center gap-2.5">
          <h2 className="panel-title">Preview</h2>
          <span className="text-2xs text-content-subtle">
            A draft instance on standard data — never the customer&rsquo;s
          </span>
        </div>
        {state?.available && preview?.status === 'ready' ? (
          <button type="button" onClick={() => void stop()} disabled={busy} className="btn-ghost px-2 py-1 text-2xs">
            Stop preview
          </button>
        ) : null}
      </div>

      <div className="space-y-2.5 px-4 py-3">
        {error ? <Alert tone="error">{error}</Alert> : null}
        {message ? <Alert tone="info">{message}</Alert> : null}

        {!state ? (
          <p className="text-xs text-content-subtle">Reading preview state…</p>
        ) : !state.available ? (
          <p className="text-xs text-content-subtle">{state.reason}</p>
        ) : preview?.status === 'creating' ? (
          <p className="flex items-center gap-2 text-xs text-content-subtle">
            <Spinner className="h-3 w-3" /> Building the preview instance…
          </p>
        ) : preview?.status === 'failed' ? (
          <Alert tone="error">{preview.error ?? 'The preview could not be built.'}</Alert>
        ) : preview?.status === 'ready' && preview.url ? (
          <div className="flex flex-wrap items-center gap-3">
            <a href={preview.url} target="_blank" rel="noreferrer" className="btn-primary py-1.5 text-xs">
              Open preview
            </a>
            <span className="font-mono text-2xs text-content-subtle">
              {preview.branch} · tears down in {formatRemaining(remaining)}
            </span>
          </div>
        ) : hasDiff ? (
          <div className="flex items-center gap-3">
            <button type="button" onClick={() => void start()} disabled={busy} className="btn-secondary py-1.5 text-xs">
              {busy ? <Spinner className="h-3 w-3" /> : null}
              {busy ? 'Building' : 'Build a preview of this draft'}
            </button>
            <span className="text-2xs text-content-subtle">
              Starts a real Odoo for this task&rsquo;s draft, on the standard database.
            </span>
          </div>
        ) : (
          <p className="text-xs text-content-subtle">
            A preview is offered once this task has a draft diff to show.
          </p>
        )}
      </div>
    </div>
  );
}
