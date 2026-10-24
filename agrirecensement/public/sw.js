/* Service worker AgriRecensement : fonctionnement hors ligne */
const VERSION = "agri-v1.0.1";
const SHELL_CACHE = "shell-" + VERSION;
const TILE_CACHE = "tuiles-carte";
const MAX_TILES = 3000;
const SHELL = [
  "/", "/index.html", "/styles.css", "/manifest.webmanifest",
  "/js/store.js", "/js/app.js", "/js/map.js", "/js/cards.js",
  "/icons/icon-192.png", "/icons/icon-512.png", "/icons/favicon.png", "/icons/apple-touch-icon.png",
  "/vendor/leaflet/leaflet.js", "/vendor/leaflet/leaflet.css",
  "/vendor/leaflet/images/marker-icon.png", "/vendor/leaflet/images/marker-icon-2x.png", "/vendor/leaflet/images/marker-shadow.png",
  "/vendor/leaflet/images/layers.png", "/vendor/leaflet/images/layers-2x.png",
  "/vendor/jspdf.umd.min.js", "/vendor/qrcode.js"
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL_CACHE).then(c => c.addAll(SHELL)));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith("shell-") && k !== SHELL_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function trimTiles() {
  const c = await caches.open(TILE_CACHE);
  const keys = await c.keys();
  if (keys.length > MAX_TILES) for (const k of keys.slice(0, keys.length - MAX_TILES)) await c.delete(k);
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // API et pages de vérification : toujours le réseau
  if (url.origin === location.origin && (url.pathname.startsWith("/api/") || url.pathname.startsWith("/verifier/"))) return;

  // Tuiles de carte : cache d'abord (consultation hors ligne des zones déjà vues)
  if (/tile\.openstreetmap\.org|tile\.opentopomap\.org|arcgisonline\.com/.test(url.host)) {
    e.respondWith(caches.open(TILE_CACHE).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok || res.type === "opaque") { c.put(req, res.clone()); trimTiles(); }
        return res;
      } catch { return new Response("", { status: 504 }); }
    }));
    return;
  }

  if (url.origin !== location.origin) return;

  // Navigation : réseau, puis application en cache
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).catch(() => caches.match("/index.html")));
    return;
  }

  // Fichiers de l'application : cache immédiat + mise à jour en arrière-plan
  e.respondWith(caches.open(SHELL_CACHE).then(async c => {
    const hit = await c.match(req);
    const net = fetch(req).then(res => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => hit);
    return hit || net;
  }));
});

self.addEventListener("message", e => { if (e.data === "skipWaiting") self.skipWaiting(); });
