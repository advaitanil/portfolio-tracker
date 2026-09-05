// Day 26 ("PWA / add-to-homescreen"). Deliberately minimal: this app is
// almost entirely live data (prices, holdings, the value chart) fetched
// straight from Supabase/the Worker, so aggressively caching API responses
// would just serve stale numbers — this only caches the static app SHELL
// (the handful of files needed to boot the page at all), and only ever
// applies cache-first to same-origin GETs for files in SHELL_ASSETS below.
// Everything else (Supabase, the Worker, anything not explicitly listed)
// always goes straight to the network, untouched.
//
// Bump CACHE_VERSION whenever a shell asset's content changes — the old
// cache is deleted on activate, so a stale index.html/app.js never lingers
// past your next deploy + the next time the app reopens.
const CACHE_VERSION = "v1";
const CACHE_NAME = `portfolio-tracker-shell-${CACHE_VERSION}`;
const SHELL_ASSETS = ["/", "/index.html", "/style.css", "/app.js", "/config.js", "/theme-init.js", "/manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only ever intercept same-origin GETs for the exact shell assets above —
  // Supabase calls, Worker calls, and anything else pass straight through
  // to the network exactly as if this service worker didn't exist.
  if (request.method !== "GET" || url.origin !== self.location.origin || !SHELL_ASSETS.includes(url.pathname)) {
    return;
  }

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(request);
      // Cache-first, but always refresh the cache in the background from the
      // network so the NEXT load picks up a new deploy — this load can still
      // serve instantly (or offline) from whatever was cached last time.
      const networkFetch = fetch(request)
        .then((res) => {
          if (res.ok) cache.put(request, res.clone());
          return res;
        })
        .catch(() => null);
      return cached || (await networkFetch) || new Response("Offline and not cached yet.", { status: 503 });
    })
  );
});
