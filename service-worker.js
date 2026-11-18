// __BUILD__ is replaced by scripts/build.mjs with a content hash, so each release
// gets its own cache and previous caches are deleted on activate.
const CACHE = "multi-hf-__BUILD__";
const CORE = [
  "./", "./index.html", "./src/app.js", "./src/styles.css",
  "./src/lib/util.js", "./src/lib/hosts.js", "./src/lib/protocol.js",
  "./src/lib/state.js", "./src/lib/queue.js",
  "./manifest.webmanifest", "./favicon.svg",
].map((path) => new URL(path, self.registration.scope).href);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(CORE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key.startsWith("multi-hf-") && key !== CACHE).map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

// Network-first for same-origin GETs so a new release wins immediately; the cache
// is the offline fallback. Cross-origin requests (the Hub, Spaces) are never cached.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return;
  if (url.origin !== self.location.origin) return;
  if (!event.request.url.startsWith(self.registration.scope)) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached ?? caches.match(new URL("./index.html", self.registration.scope).href))),
  );
});

