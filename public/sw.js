/* Finanzblick service worker: only installability and notification clicks.
   Deliberately no fetch handler and no caching, so financial data never lands in a cache. */
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const raw = event.notification.data && event.notification.data.url;
  let target = new URL("/", self.location.origin);
  try {
    const url = new URL(typeof raw === "string" ? raw : "/", self.location.origin);
    if (url.origin === self.location.origin) target = url;
  } catch {
    // Invalid URL: open the start page.
  }
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin !== target.origin) continue;
      const focused = await client.focus();
      if ("navigate" in focused) await focused.navigate(target.href).catch(() => undefined);
      return;
    }
    await self.clients.openWindow(target.href);
  })());
});
