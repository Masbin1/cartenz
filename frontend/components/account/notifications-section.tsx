'use client';

import { useEffect, useState } from 'react';
import { Bell, BellOff } from 'lucide-react';
import { ApiError, api } from '@/lib/api';
import { Spinner } from '@/components/ui/spinner';
import { Alert } from '@/components/ui/alert';
import { pushSupport, enablePush, disablePush, currentSubscription, playSound } from '@/lib/push';
import type { NotificationPreferences } from '@/lib/types';

const EVENT_TOGGLES: {
  key: keyof Omit<NotificationPreferences, 'soundEnabled'>;
  label: string;
  hint: string;
}[] = [
  {
    key: 'approvalRequired',
    label: 'Approval needed',
    hint: 'A task is waiting for you to allow or reject something.',
  },
  {
    key: 'taskCompleted',
    label: 'Task completed',
    hint: 'A task you started finished successfully.',
  },
  {
    key: 'taskFailed',
    label: 'Task failed',
    hint: 'A task you started stopped with an error.',
  },
];

type Status = 'loading' | 'off' | 'denied' | 'on' | 'unsupported' | 'unconfigured';

/**
 * Turning push on is one deliberate click (permission can only be requested
 * from a click), after which this shows which browser is registered and lets
 * the person choose what wakes it. The toggles themselves are always visible,
 * even before push is turned on: they are preferences, not a feature gate.
 */
export function NotificationsSection() {
  const [status, setStatus] = useState<Status>('loading');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [preferences, setPreferences] = useState<NotificationPreferences | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const config = await api.notifications
        .config()
        .catch(() => ({ enabled: false, publicKey: null }));
      const support = pushSupport(config.enabled);
      if (support !== 'ready') {
        if (!cancelled) setStatus(support);
        return;
      }

      if (typeof Notification !== 'undefined' && Notification.permission === 'denied') {
        if (!cancelled) setStatus('denied');
        return;
      }

      const subscription = await currentSubscription().catch(() => null);
      if (!cancelled) setStatus(subscription ? 'on' : 'off');
    })();

    api.notifications
      .preferences()
      .then((value) => {
        if (!cancelled) setPreferences(value);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  const turnOn = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const config = await api.notifications.config();
      if (!config.enabled || !config.publicKey) {
        throw new Error('Push notifications are not configured on this server.');
      }
      await enablePush(config.publicKey);
      setStatus('on');
      setNotice('Notifications are on for this browser.');
    } catch (caught) {
      if (typeof Notification !== 'undefined' && Notification.permission === 'denied') {
        setStatus('denied');
      }
      setError(caught instanceof Error ? caught.message : 'Could not turn on notifications.');
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await disablePush();
      setStatus('off');
      setNotice('Notifications are off for this browser.');
    } catch {
      setError('Could not turn off notifications.');
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.notifications.test();
      setNotice(
        result.sent > 0
          ? 'Test notification sent. It should arrive in a moment.'
          : 'No test was sent: no browser is registered yet.',
      );
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not send a test notification.');
    } finally {
      setBusy(false);
    }
  };

  const setPreference = async (patch: Partial<NotificationPreferences>) => {
    if (!preferences) return;
    const key = Object.keys(patch)[0] ?? null;
    const previous = preferences;
    setPreferences({ ...preferences, ...patch });
    setSavingKey(key);
    try {
      const saved = await api.notifications.updatePreferences(patch);
      setPreferences(saved);
      if (patch.soundEnabled) playSound('done');
    } catch {
      setPreferences(previous);
      setError('Could not save that preference.');
    } finally {
      setSavingKey(null);
    }
  };

  if (status === 'unsupported') {
    return (
      <p className="text-callout text-content-muted">
        This browser does not support notifications. Chrome, Firefox, Edge and Safari 16.4+ do.
      </p>
    );
  }

  if (status === 'unconfigured') {
    return (
      <p className="text-callout text-content-muted">
        Push notifications are not configured on this server yet.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {error || notice ? (
        <div className="space-y-3">
          {error ? <Alert tone="error">{error}</Alert> : null}
          {notice ? <Alert tone="success">{notice}</Alert> : null}
        </div>
      ) : null}

      <div className="panel flex flex-wrap items-center justify-between gap-4 p-6">
        <div className="flex items-center gap-3">
          {status === 'on' ? (
            <Bell className="h-5 w-5 text-accent" strokeWidth={1.75} aria-hidden="true" />
          ) : (
            <BellOff
              className="h-5 w-5 text-content-subtle"
              strokeWidth={1.75}
              aria-hidden="true"
            />
          )}
          <div>
            <p className="text-callout font-medium text-content">
              {status === 'loading'
                ? 'Checking…'
                : status === 'on'
                  ? 'Notifications are on for this browser'
                  : status === 'denied'
                    ? 'Notifications are blocked for this site'
                    : 'Notifications are off for this browser'}
            </p>
            {status === 'denied' ? (
              <p className="mt-0.5 text-meta text-content-subtle">
                Allow notifications for this site in your browser&apos;s settings, then reload.
              </p>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {status === 'on' ? (
            <>
              <button
                type="button"
                onClick={sendTest}
                disabled={busy}
                className="btn-secondary btn-sm"
              >
                {busy ? <Spinner /> : null}
                Send test
              </button>
              <button type="button" onClick={turnOff} disabled={busy} className="btn-ghost btn-sm">
                Turn off
              </button>
            </>
          ) : status === 'denied' ? null : (
            <button
              type="button"
              onClick={turnOn}
              disabled={busy || status === 'loading'}
              className="btn-primary btn-sm"
            >
              {busy ? <Spinner /> : null}
              Turn on notifications
            </button>
          )}
        </div>
      </div>

      {preferences ? (
        <ul className="divide-y divide-surface-border/70">
          {EVENT_TOGGLES.map(({ key, label, hint }) => (
            <li key={key} className="flex items-center justify-between gap-4 py-3.5">
              <span className="min-w-0">
                <span className="block text-callout text-content">{label}</span>
                <span className="mt-0.5 block text-meta text-content-subtle">{hint}</span>
              </span>
              <input
                type="checkbox"
                checked={preferences[key]}
                disabled={savingKey === key}
                aria-label={label}
                onChange={(event) => setPreference({ [key]: event.target.checked })}
                className="h-4 w-4 shrink-0 accent-accent"
              />
            </li>
          ))}
          <li className="flex items-center justify-between gap-4 py-3.5">
            <span className="min-w-0">
              <span className="block text-callout text-content">Play a sound</span>
              <span className="mt-0.5 block text-meta text-content-subtle">
                Only while the portal is open in a tab. A closed portal uses your device&apos;s
                default notification sound.
              </span>
            </span>
            <input
              type="checkbox"
              checked={preferences.soundEnabled}
              disabled={savingKey === 'soundEnabled'}
              aria-label="Play a sound"
              onChange={(event) => setPreference({ soundEnabled: event.target.checked })}
              className="h-4 w-4 shrink-0 accent-accent"
            />
          </li>
        </ul>
      ) : null}
    </div>
  );
}
