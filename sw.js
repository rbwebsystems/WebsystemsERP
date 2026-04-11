// Service Worker — network-first, no caching
// Hər dəfə yeni deploy olduqda brauzer avtomatik yeni faylları alır

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (e) =>
  e.waitUntil(self.clients.claim())
);

self.addEventListener("fetch", (e) => {
  // Yalnız eyni origin-in fayllarına müdaxilə et
  if (!e.request.url.startsWith(self.location.origin)) return;
  // Firestore / API sorğularına toxunma
  if (e.request.url.includes("firestore.googleapis.com")) return;
  if (e.request.url.includes("googleapis.com")) return;
  if (e.request.url.includes("telegram.org")) return;

  // Network-first: həmişə serverdən al, keş saxlama
  e.respondWith(
    fetch(e.request).catch(() =>
      new Response("Offline", { status: 503 })
    )
  );
});
