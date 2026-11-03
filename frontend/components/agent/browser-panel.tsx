'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { ArrowLeft, ArrowRight, ExternalLink, Globe, Power, RotateCw, X } from 'lucide-react';
import { ApiError, api, fetchBrowserFrame } from '@/lib/api';
import type { BrowserInput, BrowserSessionState } from '@/lib/types';

/** The server renders at this size; clicks are scaled from the shown frame to it. */
const VIEWPORT = { width: 1280, height: 800 };
const FRAME_MS = 1000;

/**
 * A browser beside the agent workspace.
 *
 * On an Odoo Online project it is a live view of a server-side session
 * (ADR-087, Option B): the person signs in here themselves, and the agent,
 * where the project grants `browser_control`, works in that same session
 * while they watch. Closing the panel's session signs it out for good.
 *
 * On any other project it is a plain iframe for a person to look at a site;
 * the agent never touches it, and odoo.sh / on-premise keep their own
 * connection.
 */
export function BrowserPanel({
  projectId,
  odooOnline,
  initialUrl,
  onClose,
}: {
  projectId: string;
  odooOnline: boolean;
  initialUrl: string | null;
  onClose: () => void;
}) {
  return (
    <aside
      aria-label="Browser"
      className="flex h-[70vh] min-w-0 flex-col overflow-hidden rounded-card border border-surface-border lg:sticky lg:top-6 lg:h-[calc(100dvh-6.5rem)]"
    >
      {odooOnline ? (
        <SessionBrowser projectId={projectId} onClose={onClose} />
      ) : (
        <FrameBrowser initialUrl={initialUrl} onClose={onClose} />
      )}
    </aside>
  );
}

function SessionBrowser({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [state, setState] = useState<BrowserSessionState | null>(null);
  const [frame, setFrame] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const imageRef = useRef<HTMLImageElement>(null);
  // The object URL behind `frame`, revoked once its replacement is set. A ref
  // rather than a second state field: `fetchFrame` reads and replaces it
  // outside React's render cycle, from both the poll timer and a click/key
  // handler, and must never revoke the URL still on screen.
  const currentFrameUrl = useRef<string | null>(null);
  // Guards the two frame sources (the 1s poll and an input's own refetch) from
  // overlapping: an input's refetch always wins, so a click never flashes a
  // stale polled frame it already made obsolete.
  const fetchInFlight = useRef(false);

  const load = useCallback(async () => {
    try {
      const next = await api.projects.browser(projectId);
      setState(next);
      if (next.url) setDraft(next.url);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The browser state could not be read.');
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const fetchFrame = useCallback(async (): Promise<boolean> => {
    if (fetchInFlight.current) return true;
    fetchInFlight.current = true;
    try {
      const next = await fetchBrowserFrame(projectId).catch(() => null);
      if (!next) return false;
      const previous = currentFrameUrl.current;
      currentFrameUrl.current = next;
      setFrame(next);
      if (previous) URL.revokeObjectURL(previous);
      return true;
    } finally {
      fetchInFlight.current = false;
    }
  }, [projectId]);

  // Poll frames while a session is open, as a floor - every input below also
  // fetches its own frame the instant the server confirms it, so a click feels
  // immediate instead of waiting out the rest of this interval. ponytail: 1 fps
  // JPEG polling, upgrade to a CDP screencast over the WebSocket if people
  // still find it choppy.
  useEffect(() => {
    if (!state?.open) return;
    let alive = true;
    const tick = async () => {
      const ok = await fetchFrame();
      if (alive && !ok) void load();
    };
    void tick();
    const timer = window.setInterval(() => void tick(), FRAME_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
      if (currentFrameUrl.current) {
        URL.revokeObjectURL(currentFrameUrl.current);
        currentFrameUrl.current = null;
      }
    };
  }, [projectId, state?.open, load, fetchFrame]);

  const send = async (input: BrowserInput) => {
    try {
      const result = await api.projects.browserInput(projectId, input);
      if (input.type !== 'type' && input.type !== 'key') setDraft(result.url);
      setError(null);
      // The page already changed server-side; show that now rather than
      // waiting up to FRAME_MS for the next scheduled poll.
      void fetchFrame();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The browser did not accept that.');
      if (caught instanceof ApiError && caught.status === 404) void load();
    }
  };

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      setState(await api.projects.openBrowser(projectId));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The browser could not start.');
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    await api.projects.closeBrowser(projectId).catch(() => undefined);
    setFrame(null);
    await load();
  };

  const click = (event: MouseEvent<HTMLImageElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    event.currentTarget.focus();
    void send({
      type: 'click',
      x: Math.round(((event.clientX - box.left) / box.width) * VIEWPORT.width),
      y: Math.round(((event.clientY - box.top) / box.height) * VIEWPORT.height),
    });
  };

  // Keys typed while the frame has focus go to the page, a character at a time.
  // ponytail: no IME composition; type into the URL box and paste if needed.
  const key = (event: KeyboardEvent<HTMLImageElement>) => {
    if (event.metaKey) return;
    event.preventDefault();
    if (event.key.length === 1 && !event.ctrlKey && !event.altKey) {
      void send({ type: 'type', text: event.key });
    } else {
      const combo = [event.ctrlKey && 'Control', event.altKey && 'Alt', event.shiftKey && event.key.length > 1 && 'Shift', event.key]
        .filter(Boolean)
        .join('+');
      void send({ type: 'key', key: combo });
    }
  };

  const navigate = (event: FormEvent) => {
    event.preventDefault();
    if (draft.trim()) void send({ type: 'navigate', url: draft.trim() });
  };

  const open = state?.open === true;

  return (
    <>
      <Toolbar
        onBack={() => void send({ type: 'back' })}
        onForward={() => void send({ type: 'forward' })}
        onReload={() => void send({ type: 'reload' })}
        disabled={!open}
        draft={draft}
        setDraft={setDraft}
        onSubmit={navigate}
        onClose={onClose}
      >
        {open ? (
          <button type="button" className="icon-btn h-8 w-8" onClick={() => void stop()} aria-label="Sign out and close session" title="Sign out and close session">
            <Power className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
          </button>
        ) : null}
      </Toolbar>

      {open ? (
        <div className="min-h-0 flex-1 overflow-auto bg-surface-overlay">
          {frame ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              ref={imageRef}
              src={frame}
              alt="Live view of the Odoo session. Click to interact; focus it and type to send keys."
              tabIndex={0}
              onClick={click}
              onKeyDown={key}
              onWheel={(event) => void send({ type: 'scroll', dy: Math.round(event.deltaY) })}
              className="block w-full cursor-pointer select-none outline-none focus-visible:ring-2 focus-visible:ring-accent"
              draggable={false}
            />
          ) : (
            <p className="p-6 text-center text-meta text-content-subtle">Connecting…</p>
          )}
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-content-subtle">
          <Globe className="h-8 w-8" strokeWidth={1.5} aria-hidden="true" />
          <p className="text-callout text-content">Sign in to this project&apos;s Odoo</p>
          <p className="max-w-sm text-meta">
            Opens your Odoo Online instance here. You sign in yourself; Cartenz keeps no password, and the
            session ends when you close it or after 30 idle minutes.
          </p>
          {state && !state.enabled ? (
            <p className="max-w-sm text-meta">The in-portal browser is off on this server.</p>
          ) : (
            <button type="button" className="btn-primary btn-sm" onClick={() => void start()} disabled={busy || !state}>
              {busy ? 'Starting…' : 'Open Odoo'}
            </button>
          )}
        </div>
      )}

      <p className="border-t border-surface-border px-3 py-1.5 text-caption text-content-subtle" role="status">
        {error ??
          (open
            ? state?.agentAllowed
              ? 'The agent can work in this session once you approve it in the chat. Users, access and settings screens stay off-limits to it.'
              : 'Only you can use this session. Grant "Browser control" in project settings to let the agent work in it.'
            : 'Odoo Online only. Odoo.sh and on-premise projects keep their existing connection.')}
      </p>
    </>
  );
}

function FrameBrowser({ initialUrl, onClose }: { initialUrl: string | null; onClose: () => void }) {
  const [history, setHistory] = useState<string[]>(initialUrl ? [initialUrl] : []);
  const [index, setIndex] = useState(initialUrl ? 0 : -1);
  const [draft, setDraft] = useState(initialUrl ?? '');
  const [reloadKey, setReloadKey] = useState(0);
  const url = index >= 0 ? history[index] : null;

  const go = (to: number) => {
    setIndex(to);
    setDraft(history[to]);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next = normalizeUrl(draft);
    if (!next) return;
    setHistory([...history.slice(0, index + 1), next]);
    setIndex(index + 1);
    setDraft(next);
  };

  return (
    <>
      <Toolbar
        onBack={() => go(index - 1)}
        onForward={() => go(index + 1)}
        onReload={() => setReloadKey((k) => k + 1)}
        disabled={!url}
        draft={draft}
        setDraft={setDraft}
        onSubmit={submit}
        onClose={onClose}
      >
        {url ? (
          <a href={url} target="_blank" rel="noreferrer" className="icon-btn h-8 w-8" aria-label="Open in new tab" title="Open in new tab">
            <ExternalLink className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
          </a>
        ) : null}
      </Toolbar>
      {url ? (
        <iframe
          key={`${url}#${reloadKey}`}
          src={url}
          title="Browser"
          className="min-h-0 flex-1 bg-white"
          // No allow-top-navigation, so a framed page cannot navigate Cartenz itself.
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals"
        />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-content-subtle">
          <Globe className="h-8 w-8" strokeWidth={1.5} aria-hidden="true" />
          <p className="text-callout text-content">Browse the web</p>
          <p className="text-meta">Type a URL to open a site.</p>
        </div>
      )}
      {url ? (
        <p className="border-t border-surface-border px-3 py-1.5 text-caption text-content-subtle">
          Blank page? The site refuses to be shown inside another app. Use{' '}
          <a href={url} target="_blank" rel="noreferrer" className="link">
            open in new tab
          </a>
          .
        </p>
      ) : null}
    </>
  );
}

function Toolbar({
  onBack,
  onForward,
  onReload,
  disabled,
  draft,
  setDraft,
  onSubmit,
  onClose,
  children,
}: {
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  disabled: boolean;
  draft: string;
  setDraft: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  onClose: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1 border-b border-surface-border p-2">
      <button type="button" className="icon-btn h-8 w-8" onClick={onBack} disabled={disabled} aria-label="Back">
        <ArrowLeft className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
      </button>
      <button type="button" className="icon-btn h-8 w-8" onClick={onForward} disabled={disabled} aria-label="Forward">
        <ArrowRight className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
      </button>
      <button type="button" className="icon-btn h-8 w-8" onClick={onReload} disabled={disabled} aria-label="Reload">
        <RotateCw className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
      </button>
      <form onSubmit={onSubmit} className="min-w-0 flex-1">
        <label htmlFor="browser-url" className="sr-only">
          URL
        </label>
        <input
          id="browser-url"
          type="text"
          inputMode="url"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Type a URL"
          className="field-input h-8 w-full text-meta"
        />
      </form>
      {children}
      <button type="button" className="icon-btn h-8 w-8" onClick={onClose} aria-label="Hide browser">
        <X className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
      </button>
    </div>
  );
}

/** Adds https:// to a bare host; only http(s) is allowed, so `javascript:` cannot run. */
export function normalizeUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}
