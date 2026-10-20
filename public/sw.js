/* Offline shell: the app opens instantly and works without a signal (duels and saving need a connection).
   v2: on install, the whole game (page + every hashed asset it loads) is saved for offline play,
   and each online visit refreshes that copy and drops assets from older builds. */
const CACHE = "dt-shell-v2";
const CORE = ["/", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/icon-maskable-512.png", "/icons/apple-touch-icon.png"];

/* every /assets/… file the page needs: the ones in index.html plus the ones its scripts load (the game engine) */
async function assetsOf(html, cache) {
  const found = new Set(html.match(/\/assets\/[\w.-]+/g) || []);
  for (const u of [...found]) {
    if (!u.endsWith(".js")) continue;
    let r = await cache.match(u);
    if (!r) { try { r = await fetch(u); if (r.ok) await cache.put(u, r.clone()); } catch { continue; } }
    const js = await r.text();
    for (const m of js.match(/\/?assets\/[\w.-]+\.(?:js|css|png|webp|jpg|svg|woff2?)/g) || []) found.add(m.startsWith("/") ? m : "/" + m);
  }
  return found;
}
async function syncAssets(html) {
  const c = await caches.open(CACHE), keep = await assetsOf(html, c);
  await Promise.all([...keep].map((u) => c.match(u).then((hit) => hit || c.add(u).catch(() => {}))));
  for (const req of await c.keys()) { const p = new URL(req.url).pathname; if (p.startsWith("/assets/") && !keep.has(p)) await c.delete(req); }
}

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await c.addAll(CORE);
    try { await syncAssets(await (await c.match("/")).text()); } catch {}
  })());
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET") return;
  if (url.origin === location.origin && (url.pathname.startsWith("/api/") || url.pathname.startsWith("/socket.io/"))) return;
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).then((r) => {
      if (r.ok) { const a = r.clone(), b = r.clone(); caches.open(CACHE).then((x) => x.put("/", a)); e.waitUntil(b.text().then(syncAssets).catch(() => {})); }
      return r;
    }).catch(() => caches.match("/")));
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
