/* Cartenz service worker: web push only (ADR-065).
 *
 * Deliberately does nothing else. No fetch handler, no offline cache: a
 * service worker that intercepts requests can serve a stale portal after a
 * deploy, and the portal has no offline story to justify that risk.
 *
 * What it does:
 *   - `push`: shows the notification the backend sent. The payload carries a
 *     title, a one-line body, the task link and which sound to play - never
 *     the prompt, a diff or Odoo data (it transits a third-party push service
 *     and sits on the lock screen).
 *   - Tells every open portal tab, so a tab can play the sound. A service
 *     worker cannot play audio itself, and browsers do not let a notification
 *     choose its own sound: a closed portal gets the operating system's sound.
 *   - `notificationclick`: focuses a tab already on that task, or any portal
 *     tab (navigated there), or opens a new one.
 */

self.addEventListener('install', () => {
  // A new worker takes over at once: there is no cached state to migrate.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload;
  try {
    payload = event.data ? event.data.json() : null;
  } catch {
    payload = null;
  }
  if (!payload || typeof payload.title !== 'string') {
    // A push must show something, or Chrome shows its own generic notice and
    // may revoke the subscription for "silent push".
    payload = {
      title: 'Cartenz',
      body: 'Something needs your attention.',
      url: '/dashboard',
    };
  }

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });

      // Is the person already looking at this very task? Then the tab shows it
      // and plays the sound; a system notification on top would be noise.
      const taskPath = payload.url ? new URL(payload.url, self.location.origin).pathname : null;
      const watching = windows.some(
        (client) =>
          client.focused &&
          client.visibilityState === 'visible' &&
          taskPath &&
          new URL(client.url).pathname === taskPath &&
          new URL(client.url).searchParams.get('task') === payload.taskId,
      );

      for (const client of windows) {
        client.postMessage({ type: 'cartenz-push', payload, watching });
      }

      if (watching) return;

      await self.registration.showNotification(payload.title, {
        body: payload.body || '',
        tag: payload.tag || undefined,
        // Replacing a notification with the same tag would otherwise be silent.
        renotify: Boolean(payload.tag),
        requireInteraction: Boolean(payload.requireInteraction),
        silent: payload.sound === null,
        icon: '/brand/icon-192.png',
        badge: '/brand/icon-64.png',
        data: { url: payload.url || '/dashboard' },
      });
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/dashboard', self.location.origin);

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });

      const exact = windows.find((client) => client.url === target.href);
      if (exact) return exact.focus();

      const portal = windows.find((client) => new URL(client.url).origin === target.origin);
      if (portal) {
        await portal.focus();
        return portal.navigate(target.href).catch(() => self.clients.openWindow(target.href));
      }

      return self.clients.openWindow(target.href);
    })(),
  );
});

// The browser rotated the subscription (rare, but Firefox does it). Nothing
// can be re-registered from here without the person's session, so the next
// visit to the portal re-subscribes; the backend drops the old endpoint when
// the push service answers 410.
self.addEventListener('pushsubscriptionchange', () => {});
