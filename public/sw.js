/* Offline shell: the app opens instantly and works without a signal (duels and saving need a connection). */
const CACHE = "dt-shell-v1";
self.addEventListener("install", (e) => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then((c) => c.addAll(["/", "/manifest.webmanifest", "/icons/icon-192.png"]))); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET") return;
  if (url.origin === location.origin && (url.pathname.startsWith("/api/") || url.pathname.startsWith("/socket.io/"))) return;
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).then((r) => { const c = r.clone(); caches.open(CACHE).then((x) => x.put("/", c)); return r; }).catch(() => caches.match("/")));
    return;
  }
  const hashed = url.origin === location.origin && url.pathname.startsWith("/assets/");
  const fonts = /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
  if (!hashed && !fonts && url.origin !== location.origin) return;
  e.respondWith(caches.match(req).then((hit) => {
    const net = fetch(req).then((r) => { if (r.ok || r.type === "opaque") { const c = r.clone(); caches.open(CACHE).then((x) => x.put(req, c)); } return r; });
    return hashed && hit ? hit : hit ? (net.catch(() => hit), hit) : net;
  }));
});
