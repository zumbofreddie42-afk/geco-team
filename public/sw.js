// Service worker: receives phone notifications (Web Push) and opens the right screen when one is tapped.
// No offline caching: the team always sees fresh data.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data && event.data.text() }; }
  event.waitUntil(self.registration.showNotification(data.title || 'Geco Team', {
    body: data.body || '',
    icon: '/img/icon-192.png',
    badge: '/img/icon-192.png',
    tag: data.tag || undefined,
    data: { link: data.link || '' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(`/${event.notification.data.link || ''}`, self.location.origin).href;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (new URL(c.url).origin === self.location.origin) {
        await c.focus();
        return c.navigate(url);
      }
    }
    return self.clients.openWindow(url);
  })());
});
