// ShiftBoard's service worker: phone notifications only.
// It has no fetch handler and caches nothing, so the app and the API always come straight from
// the server and every deploy shows up on the next load.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// A notification from the server: { title: restaurant name, body: text, url: '/#/my' }.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(self.registration.showNotification(data.title || 'ShiftBoard', {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    data: { url: data.url || '/' },
  }));
});

// Tapping it focuses the app (or opens it) on the notification's page.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  let target = new URL(event.notification.data?.url || '/', self.location.origin);
  if (target.origin !== self.location.origin) target = new URL('/', self.location.origin);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find((w) => new URL(w.url).origin === target.origin);
    if (open) {
      await open.focus();
      // The app uses #/ routes: it switches page when it gets this message (web/src/push.js).
      open.postMessage({ type: 'shiftboard:open', url: target.href });
      return;
    }
    await self.clients.openWindow(target.href);
  })());
});
