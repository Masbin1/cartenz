'use client';

import { api } from './api';

/**
 * Web push (ADR-065): registering the service worker, keeping this browser
 * subscribed (on by default, off if the person said so), and playing the sound
 * for a push that lands while the portal is open.
 *
 * Not a React hook on purpose - the account page is the only place a person
 * changes this, but the sound needs to play from any open tab, so the message
 * listener is wired once from a layout-level effect instead of tied to
 * whichever page happens to be mounted.
 */

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register('/sw.js');
  } catch {
    return null;
  }
}

/**
 * Push is opt-out (ADR-065 amendment): every signed-in browser is subscribed
 * unless the person turned it off here. The flag is per browser, because a
 * subscription is per browser; the per-event switches stay server-side.
 */
const OPT_OUT_KEY = 'cartenz.push.optedOut';

export function isOptedOut(): boolean {
  try {
    return window.localStorage.getItem(OPT_OUT_KEY) === '1';
  } catch {
    return false;
  }
}

function setOptedOut(value: boolean): void {
  try {
    if (value) window.localStorage.setItem(OPT_OUT_KEY, '1');
    else window.localStorage.removeItem(OPT_OUT_KEY);
  } catch {
    // Private mode without storage: the choice lasts for this page only.
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

  setOptedOut(false);
  return subscribeAndRegister(registration, vapidPublicKey);
}

/** Subscribes (reusing an existing subscription) and stores it server-side. */
async function subscribeAndRegister(
  registration: ServiceWorkerRegistration,
  vapidPublicKey: string,
): Promise<PushSubscription> {
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

export type AutoPushState =
  | 'on'
  | 'needs_permission'
  | 'denied'
  | 'opted_out'
  | 'unsupported'
  | 'unconfigured';

/**
 * Turns push on without asking, wherever the browser allows that.
 *
 * Called on every signed-in page load. With permission already granted it
 * subscribes (or re-attaches an existing subscription) silently. It never
 * calls `requestPermission` itself: a prompt not triggered by a click is what
 * browsers answer by muting the site's notifications for good. When
 * permission is still undecided it reports `needs_permission`, and the portal
 * shows a banner whose button makes the request from a real click.
 */
export async function autoEnablePush(): Promise<AutoPushState> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return 'unsupported';
  if (!('PushManager' in window) || typeof Notification === 'undefined') return 'unsupported';
  if (isOptedOut()) return 'opted_out';
  if (Notification.permission === 'denied') return 'denied';

  const config = await api.notifications
    .config()
    .catch(() => ({ enabled: false, publicKey: null as string | null }));
  if (!config.enabled || !config.publicKey) return 'unconfigured';

  if (Notification.permission === 'default') return 'needs_permission';

  const registration = await registerServiceWorker();
  if (!registration) return 'unsupported';
  try {
    await subscribeAndRegister(registration, config.publicKey);
    return 'on';
  } catch {
    return 'needs_permission';
  }
}

export async function disablePush(): Promise<void> {
  // Remembered before anything can fail, so the next page load does not
  // quietly turn back on what the person just turned off.
  setOptedOut(true);
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
 * Removes the server's row for this browser without touching the browser's own
 * subscription or its permission.
 *
 * Signing out has to stop the next person at a shared machine from receiving
 * the previous person's approvals. Unsubscribing the browser would also work,
 * but then the next sign-in would prompt for permission all over again - so
 * only the server-side link is cut, and `autoEnablePush` re-attaches it.
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
