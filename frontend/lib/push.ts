'use client';

import { api } from './api';

/**
 * Web push (ADR-065): registering the service worker, turning the browser's
 * permission and subscription state into one on/off toggle, and playing the
 * sound for a push that lands while the portal is open.
 *
 * Not a React hook on purpose - the account page is the only place a person
 * changes this, but the sound needs to play from any open tab, so the message
 * listener is wired once from a layout-level effect instead of tied to
 * whichever page happens to be mounted.
 */

export type PushSupport = 'unsupported' | 'unconfigured' | 'ready';

export function pushSupport(configEnabled: boolean): PushSupport {
  if (typeof window === 'undefined') return 'unsupported';
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return 'unsupported';
  if (!configEnabled) return 'unconfigured';
  return 'ready';
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register('/sw.js');
  } catch {
    return null;
  }
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  const registration = await registerServiceWorker();
  if (!registration) return null;
  return registration.pushManager.getSubscription();
}

/** Asks the browser for permission, then subscribes and tells the backend. */
export async function enablePush(vapidPublicKey: string): Promise<PushSubscription> {
  const registration = await registerServiceWorker();
  if (!registration) throw new Error('This browser does not support push notifications.');

  // Permission can only be requested from a click, which is exactly where this
  // is called from - a page load asking for it is what gets a site's
  // notification permission auto-denied for good.
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(
      permission === 'denied'
        ? 'Notifications are blocked for this site. Allow them in your browser settings and try again.'
        : 'Notification permission was not granted.',
    );
  }

  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    }));

  const json = subscription.toJSON() as {
    endpoint: string;
    keys?: { p256dh: string; auth: string };
  };
  if (!json.keys) throw new Error('The browser did not return subscription keys.');
  await api.notifications.subscribe({
    endpoint: json.endpoint,
    keys: json.keys,
  });

  return subscription;
}

export async function disablePush(): Promise<void> {
  const subscription = await currentSubscription();
  if (!subscription) return;
  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();
  await api.notifications.unsubscribe(endpoint).catch(() => {
    // The browser side is already off; a failed server-side cleanup is a
    // stale row the next 410 response will clear, not something to surface.
  });
}

/**
 * Re-registers an existing subscription with the backend, without asking the
 * person anything. Called once per sign-in: it repairs the two ordinary ways a
 * subscription row goes missing (the backend's VAPID keys were rotated, or a
 * 410 from the push service dropped the row), and it is a no-op when the
 * browser has not been granted permission or has no subscription yet.
 */
export async function syncPushSubscription(): Promise<void> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;

  const subscription = await currentSubscription().catch(() => null);
  if (!subscription) return;

  const json = subscription.toJSON() as {
    endpoint: string;
    keys?: { p256dh: string; auth: string };
  };
  if (!json.keys) return;
  await api.notifications.subscribe({ endpoint: json.endpoint, keys: json.keys }).catch(() => {
    // Not worth surfacing on a page load; the account page reports the state
    // properly when the person goes there.
  });
}

/**
 * Removes the server's row for this browser without touching the browser's own
 * subscription or its permission.
 *
 * Signing out has to stop the next person at a shared machine from receiving
 * the previous person's approvals. Unsubscribing the browser would also work,
 * but then the next sign-in would prompt for permission all over again - so
 * only the server-side link is cut, and `syncPushSubscription` re-attaches it.
 */
export async function detachPushSubscription(): Promise<void> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
  const subscription = await currentSubscription().catch(() => null);
  if (!subscription) return;
  await api.notifications.unsubscribe(subscription.endpoint).catch(() => {
    // Sign-out proceeds regardless; a row left behind belongs to a user id
    // whose token no longer exists.
  });
}

interface CartenzPushMessage {
  type: 'cartenz-push';
  watching: boolean;
  payload: {
    sound: 'approval' | 'done' | 'failed' | null;
  };
}

function isCartenzPushMessage(value: unknown): value is CartenzPushMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'cartenz-push'
  );
}

/**
 * Plays the sound for a push that arrives while a tab is open, including when
 * that tab is the one showing the task (the service worker skips the system
 * notification there, but the sound still needs to play). Call once, e.g.
 * from a top-level layout effect; safe to call more than once.
 */
export function listenForPush(onMessage?: (message: CartenzPushMessage) => void): () => void {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return () => {};

  const handler = (event: MessageEvent) => {
    if (!isCartenzPushMessage(event.data)) return;
    onMessage?.(event.data);
    if (event.data.payload.sound) playSound(event.data.payload.sound);
  };

  navigator.serviceWorker.addEventListener('message', handler);
  return () => navigator.serviceWorker.removeEventListener('message', handler);
}

const SOUND_FILES: Record<'approval' | 'done' | 'failed', string> = {
  approval: '/sounds/approval.wav',
  done: '/sounds/done.wav',
  failed: '/sounds/failed.wav',
};

export function playSound(sound: 'approval' | 'done' | 'failed'): void {
  try {
    const audio = new Audio(SOUND_FILES[sound]);
    audio.volume = 0.6;
    void audio.play().catch(() => {
      // Autoplay can be blocked before the person has interacted with the
      // page at all; there is nothing useful to do about that here.
    });
  } catch {
    // Non-fatal: the notification itself still showed.
  }
}

/** The browser's push subscribe call wants a raw Uint8Array, not base64url. */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}
