/* eslint-disable no-restricted-globals */

const CACHE_NAME = 'runwise-v5';
const API_CACHE_NAME = 'runwise-api-v1';

const urlsToCache = [
  '/',
  '/index.html',
  '/manifest.json'
];

// API paths to cache for offline viewing
const CACHEABLE_API_PATHS = [
  '/api/workouts',
  '/api/workouts/stats',
  '/api/workouts/weekly',
  '/api/workouts/goals/list',
  '/api/workouts/goals/predictions',
  '/api/ai/plan',
  '/api/ai/chat/history',
  '/api/strava/sync-status'
];

function isApiRequest(url) {
  return CACHEABLE_API_PATHS.some(path => url.pathname.endsWith(path) || url.pathname.includes('/api/workouts'));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(urlsToCache))
  );
  self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Ignore non-http(s) requests and non-GET methods (can't cache POST)
  if (!url.protocol.startsWith('http') || event.request.method !== 'GET') return;

  // API requests: network-first, fallback to cache
  if (isApiRequest(url)) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          // Clone and cache successful responses
          if (response.ok) {
            const responseClone = response.clone();
            caches.open(API_CACHE_NAME).then((cache) => {
              cache.put(event.request, responseClone);
            });
          }
          return response;
        })
        .catch(() => {
          // Offline — serve from cache
          return caches.match(event.request);
        })
    );
    return;
  }

  // Static assets: network-first to avoid stale cache issues
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      })
      .catch(() => {
        return caches.match(event.request).then((cached) => {
          if (cached) return cached;
          if (event.request.destination === 'document') {
            return caches.match('/index.html');
          }
        });
      })
  );
});

self.addEventListener('activate', (event) => {
  const validCaches = [CACHE_NAME, API_CACHE_NAME];
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => !validCaches.includes(name))
          .map((name) => caches.delete(name))
      );
    })
  );
  self.clients.claim();
});
