/* bWalletX web wallet: Web Push service worker (served as /push-sw.js, vite.config.web.ts).
 * Shows what push.bwalletx.com sends ({title, body, tag, data, urgent}) and, on a click, focuses the wallet
 * and opens the room: an open tab gets a message, otherwise a new one opens with ?push=<rooms|dms>:<TICKER>.
 * Mirrors src/mobile/push/logic.ts (webNotification, routeFromData, routeToQuery); keep them in step. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let p = {};
  try {
    p = event.data ? event.data.json() : {};
  } catch (_) {
    p = {};
  }
  const data = p && typeof p.data === 'object' && p.data ? p.data : {};
  event.waitUntil(
    self.registration.showNotification(typeof p.title === 'string' && p.title ? p.title : 'bWalletX', {
      body: typeof p.body === 'string' ? p.body : '',
      tag: typeof p.tag === 'string' && p.tag ? p.tag : undefined,
      data,
      icon: './icons/icon192.png',
      requireInteraction: p.urgent === true,
    }),
  );
});

const routeQuery = (d) => {
  if (!d || d.kind === 'call') return '';
  let t = typeof d.ticker === 'string' ? d.ticker : typeof d.room === 'string' ? d.room : '';
  if (!t && typeof d.url === 'string') {
    const m = /\/room\/([^/?#]+)/.exec(d.url);
    if (m) t = decodeURIComponent(m[1]);
  }
  t = t.trim().replace(/^\$/, '').toUpperCase();
  if (!/^[A-Z0-9_.-]{1,64}$/.test(t)) return '';
  const dm = d.dm === true || d.dm === 'true' || d.dm === '1';
  return `push=${dm ? 'dms' : 'rooms'}:${encodeURIComponent(t)}`;
};

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const query = routeQuery(event.notification.data);
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const own = wins.find((c) => new URL(c.url).origin === self.location.origin);
      if (own) {
        await own.focus();
        if (query) own.postMessage({ type: 'bwallet-push-route', query: `?${query}` });
        return;
      }
      await self.clients.openWindow(`./${query ? `?${query}` : ''}`);
    })(),
  );
});
