const CACHE_NAME = "six-pm-sprint-v5";

// The app shell must move as one unit. src/game.js dereferences ids from
// index.html at module scope, so an old HTML + new JS pairing is a hard
// TypeError and a blank stage rather than a degraded page. Serving these
// network-first keeps every load on a single deployed version — which also
// protects the premise that everyone is racing the same daily map, since a
// stale engine.js would generate a different one.
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./src/engine.js",
  "./src/game.js",
  "./manifest.webmanifest"
];

// Icons never change without also changing their filename, so they can be
// served straight from the cache.
const PRECACHE = [...SHELL, "./assets/icon.svg"];

const absolute = (path) => new URL(path, self.location.href).href;
const SHELL_URLS = new Set(SHELL.map(absolute));
const INDEX_URL = absolute("./index.html");

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

// Navigations arrive with the player's ?seed=/?ghost= query attached, so they
// all share one cache entry: the shell HTML.
const cacheKeyFor = (request) => (request.mode === "navigate" ? INDEX_URL : request);

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const key = cacheKeyFor(request);
  try {
    // GitHub Pages serves max-age=600, which would let a ten-minute-old copy
    // satisfy this fetch. Revalidating turns it into a cheap 304 instead.
    // A navigate request cannot be rebuilt without downgrading its mode, so it
    // is passed through untouched.
    const fresh = request.mode === "navigate"
      ? await fetch(request)
      : await fetch(new Request(request, { cache: "no-cache" }));
    if (fresh.ok) cache.put(key, fresh.clone());
    return fresh;
  } catch (error) {
    const cached = await cache.match(key);
    if (cached) return cached;
    throw error;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const fresh = await fetch(request);
  if (fresh.ok) cache.put(request, fresh.clone());
  return fresh;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate" || SHELL_URLS.has(url.href)) {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(cacheFirst(request));
});
