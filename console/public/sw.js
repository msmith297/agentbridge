// agent-bridge console service worker: shows push notifications (new messages for the operator,
// approval requests) and opens the right page when one is tapped.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

// Safari revokes push permission when a push shows no notification, so only other browsers
// skip notifications while the console is in front of you.
const strictBrowser = /iPhone|iPad|Macintosh/.test(navigator.userAgent) && !/Chrome|Firefox|Edg\//.test(navigator.userAgent);

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data?.text() }; }
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (!strictBrowser && !data.approval && windows.some(w => w.focused && w.visibilityState === 'visible')) return;
    await self.registration.showNotification(data.title || 'Agent Bridge', {
      body: data.body || '',
      tag: data.tag,
      renotify: Boolean(data.tag),
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: data.url || '/' },
      requireInteraction: Boolean(data.approval),
    });
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find(w => new URL(w.url).origin === self.location.origin);
    if (open) {
      await open.focus();
      return open.navigate ? open.navigate(url) : undefined;
    }
    return self.clients.openWindow(url);
  })());
});
