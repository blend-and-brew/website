/* ============================================================
   Blend & Brew — Service Worker
   Caches static assets (images, fonts, external libs) so repeat
   visits load instantly and the site keeps working offline for
   anything already cached.

   Deliberately bypassed (never cached, always network):
   - Google Apps Script (blocked-dates + booking sync) — must
     always be fresh, and never a POST anyway
   - Formspree (booking submissions)
   - Nominatim (address autocomplete)
   - OSRM (routing/travel distance), if used
   ============================================================ */

const STATIC_CACHE  = 'bnb-static-v1';
const RUNTIME_CACHE = 'bnb-runtime-v1';
const CURRENT_CACHES = [STATIC_CACHE, RUNTIME_CACHE];

// Hostnames that must always go straight to the network — booking
// data, form submissions, and third-party lookups should never be
// served stale from cache.
const BYPASS_HOSTNAMES = [
  'script.google.com',
  'formspree.io',
  'nominatim.openstreetmap.org',
  'router.project-osrm.org'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => !CURRENT_CACHES.includes(key))
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

async function cacheFirst(request, cacheName){
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response && response.status === 200){
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    if (cached) return cached;
    throw err;
  }
}

async function networkFirst(request, cacheName){
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response && response.status === 200){
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Only ever handle GET — form POSTs (Formspree, Apps Script) are
  // left completely untouched.
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch (err) {
    return;
  }

  // Never intercept the dynamic/live endpoints listed above.
  if (BYPASS_HOSTNAMES.some((host) => url.hostname.includes(host))) return;

  // Images — cache-first, this is the bulk of the page weight
  // (webp photography, logos, textures).
  if (request.destination === 'image'){
    event.respondWith(cacheFirst(request, RUNTIME_CACHE));
    return;
  }

  // Fonts + known static-asset CDNs (Google Fonts, cdnjs) — also
  // safe to cache-first since these are versioned/immutable URLs.
  if (
    request.destination === 'font' ||
    url.hostname.includes('fonts.gstatic.com') ||
    url.hostname.includes('fonts.googleapis.com') ||
    url.hostname.includes('cdnjs.cloudflare.com')
  ){
    event.respondWith(cacheFirst(request, RUNTIME_CACHE));
    return;
  }

  // The page itself — network-first so edits always show up
  // immediately, with a cached fallback for offline access.
  if (request.mode === 'navigate'){
    event.respondWith(networkFirst(request, STATIC_CACHE));
    return;
  }

  // Any other same-origin static file (CSS/JS if split out later).
  if (url.origin === self.location.origin){
    event.respondWith(cacheFirst(request, RUNTIME_CACHE));
  }
});
