// VISART ARCHDESIGN — service worker
// Maqsad: PWA sifatida "o'rnatish" imkonini berish + oddiy offline-qobiliyat.
// Ma'lumotlar (Supabase) doim tarmoqdan olinadi — bu yerda faqat ilova "qobig'i" keshlanadi.

const CACHE_NAME = 'visart-shell-v7';
const SHELL_FILES = [
  './',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './badge-96.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('./');
    })
  );
});

// ─── HAQIQIY FON-BILDIRISHNOMA: server yuborgan push xabarini ko'rsatadi ───
// (ilova yopiq bo'lsa ham ishlaydi — bu native brauzer/OS imkoniyati)
self.addEventListener('push', (event) => {
  let data = { title: 'VISART', body: 'Yangilanish bor' };
  try { if (event.data) data = event.data.json(); } catch (e) {}
  event.waitUntil(
    (async () => {
      await self.registration.showNotification(data.title || 'VISART', {
        body: data.body || '',
        icon: 'icon-192.png',
        badge: 'badge-96.png', // Android holat panelida ko'rsatiladigan oq-silueta ikonka
        tag: 'visart-push-' + Date.now(),
        vibrate: [100, 50, 100],
      });
      // Ilova butunlay yopiq bo'lsa ham, bosh ekrandagi belgiga nishona qo'yamiz
      if ('setAppBadge' in navigator) {
        try { await navigator.setAppBadge(1); } catch (e) {}
      }
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // Supabase va boshqa tashqi API so'rovlariga tegmaymiz — doim tarmoqdan
  if (!req.url.startsWith(self.location.origin)) return;

  event.respondWith(
    (async () => {
      const cached = await caches.match(req).catch(() => null);
      try {
        const res = await fetch(req);
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return res;
      } catch (e) {
        // Tarmoq yo'q — keshdan beramiz, u ham bo'lmasa, bosh sahifaga qaytamiz
        if (cached) return cached;
        const fallback = await caches.match('./').catch(() => null);
        if (fallback) return fallback;
        return new Response('Offline', { status: 503, statusText: 'Offline' });
      }
    })()
  );
});
