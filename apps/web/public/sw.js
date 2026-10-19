// Service worker de CalaSign (PWA).
// Reglas: solo se guardan archivos estáticos (/assets con hash; /pdfjs e /icons, que se refrescan en segundo plano) y la página offline.
// Nunca se guardan respuestas de la API (/v1), documentos PDF, ni las páginas de la app (siempre de la red).
const VERSION = "calasign-v1";
const STATIC = `${VERSION}-static`;
const OFFLINE_URL = "/offline.html";
const PRECACHE = [OFFLINE_URL, "/icons/icon-192.png", "/icons/icon.svg", "/manifest.webmanifest"];
// VERSION no cambia en cada deploy: sin un tope, los /assets con hash de cada versión vieja (unos 3 MB por deploy) se
// acumulaban para siempre en la caché. Se conservan los más recientes (keys() devuelve el orden de inserción).
const MAX_ASSETS = 40;

function trimAssets(cache) {
  return cache.keys().then((keys) => {
    const assets = keys.filter((k) => new URL(k.url).pathname.startsWith("/assets/"));
    return Promise.all(assets.slice(0, Math.max(0, assets.length - MAX_ASSETS)).map((k) => cache.delete(k)));
  });
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC)
      .then((c) => c.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function isCacheableStatic(url) {
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith("/v1/") || url.pathname.startsWith("/dev/") || url.pathname.startsWith("/embed/")) return false;
  if (url.pathname.toLowerCase().endsWith(".pdf")) return false;
  return url.pathname.startsWith("/assets/") || url.pathname.startsWith("/pdfjs/") || url.pathname.startsWith("/icons/");
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Descargas de integraciones y complemento de Office: siempre directo a la red, sin pasar por el service worker
  // (una descarga que falla no debe terminar en la página offline).
  if (url.origin === self.location.origin && url.pathname.startsWith("/integrations/")) return;

  // Navegación (páginas de la app): siempre de la red; sin conexión, la página offline.
  if (req.mode === "navigate") {
    event.respondWith(fetch(req).catch(() => caches.match(OFFLINE_URL)));
    return;
  }

  if (isCacheableStatic(url)) {
    const network = () =>
      fetch(req).then((res) => {
        if (res.ok && res.type === "basic") {
          const copy = res.clone();
          const saved = caches
            .open(STATIC)
            .then((c) => c.put(req, copy).then(() => (url.pathname.startsWith("/assets/") ? trimAssets(c) : undefined)))
            .catch(() => undefined);
          try {
            event.waitUntil(saved);
          } catch {
            /* el evento ya terminó: el guardado sigue igual */
          }
        }
        return res;
      });
    // /assets lleva hash en el nombre (inmutable): primero la caché. /pdfjs e /icons NO tienen hash y VERSION no cambia
    // con cada deploy: se sirve la copia guardada pero se refresca en segundo plano (si no, quedarían viejos para siempre).
    const hashed = url.pathname.startsWith("/assets/");
    event.respondWith(
      caches.match(req).then((hit) => {
        if (hit && hashed) return hit;
        const fresh = network();
        if (!hit) return fresh;
        event.waitUntil(fresh.catch(() => undefined));
        return hit;
      }),
    );
  }
  // Todo lo demás (API, PDF, etc.): el navegador va directo a la red.
});
