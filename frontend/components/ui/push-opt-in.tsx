'use client';

import { useEffect, useState } from 'react';
import { Bell } from 'lucide-react';
import { api } from '@/lib/api';
import { autoEnablePush, enablePush, type AutoPushState } from '@/lib/push';

const DISMISSED_KEY = 'cartenz.push.bannerDismissed';

/**
 * Push is opt-out (ADR-065 amendment): the platform turns notifications on for
 * everyone, and a person turns them off for themselves.
 *
 * Everything that can be done without asking is done silently by
 * `autoEnablePush` on every signed-in page. The one thing no page can do
 * without a person is the browser's own permission prompt, so that is what
 * this banner exists for: it appears only while permission is undecided, and
 * its button makes the request from a real click - which is the only kind of
 * request browsers answer.
 *
 * Nothing is shown once notifications are on, denied, or turned off here: two
 * of those are the person's own decision, and repeating them would be nagging.
 */
export function PushOptIn() {
  const [state, setState] = useState<AutoPushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    try {
      setDismissed(window.sessionStorage.getItem(DISMISSED_KEY) === '1');
    } catch {
      // Private mode: the banner may reappear on navigation, which is fine.
    }
    let cancelled = false;
    void autoEnablePush().then((result) => {
      if (!cancelled) setState(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const dismiss = () => {
    setDismissed(true);
    try {
      window.sessionStorage.setItem(DISMISSED_KEY, '1');
    } catch {
      // Nothing to persist; the banner returns on the next page load.
    }
  };

  const turnOn = async () => {
    setBusy(true);
    setError(null);
    try {
      const config = await api.notifications.config();
      if (!config.enabled || !config.publicKey) throw new Error('unconfigured');
      await enablePush(config.publicKey);
      setState('on');
    } catch (caught) {
      if (typeof Notification !== 'undefined' && Notification.permission === 'denied') {
        setState('denied');
      } else {
        setError(
          caught instanceof Error && caught.message
            ? caught.message
            : 'Notifications could not be turned on.',
        );
      }
    } finally {
      setBusy(false);
    }
  };

  if (state !== 'needs_permission' || dismissed) return null;

  return (
    <div className="border-b border-surface-border bg-surface-raised">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-8">
        <div className="flex min-w-0 items-center gap-3">
          <Bell className="h-4 w-4 shrink-0 text-accent" strokeWidth={1.75} aria-hidden="true" />
          <p className="text-callout text-content-muted">
            Get a sound and a notification when a task needs your approval or finishes.{' '}
            {error ? <span className="text-state-failure">{error}</span> : null}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" onClick={turnOn} disabled={busy} className="btn-primary btn-sm">
            Turn on
          </button>
          <button type="button" onClick={dismiss} className="btn-ghost btn-sm">
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
