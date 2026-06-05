/// <reference lib="webworker" />
import { cleanupOutdatedCaches, precacheAndRoute, matchPrecache } from "workbox-precaching";
import { registerRoute, NavigationRoute } from "workbox-routing";
import { CacheFirst, StaleWhileRevalidate, NetworkFirst } from "workbox-strategies";
import { CacheableResponsePlugin } from "workbox-cacheable-response";
import { ExpirationPlugin } from "workbox-expiration";
import { clientsClaim } from "workbox-core";

declare let self: ServiceWorkerGlobalScope;

void self.skipWaiting();
clientsClaim();
cleanupOutdatedCaches();

precacheAndRoute(self.__WB_MANIFEST);

self.addEventListener("activate", (event: ExtendableEvent) => {
  event.waitUntil(
    caches.delete("pages").then(() => {
      console.warn("[SW] Purged legacy pages cache to prevent update lockouts.");
    })
  );
});

registerRoute(
  ({ request }) =>
    request.destination === "script" ||
    request.destination === "style" ||
    request.destination === "worker",
  new StaleWhileRevalidate({
    cacheName: "assets-runtime",
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({ maxEntries: 100, maxAgeSeconds: 24 * 60 * 60 }),
    ]
  })
);

const navigationStrategy = new NetworkFirst({
  cacheName: "html-cache",
  plugins: [
    new CacheableResponsePlugin({ statuses: [200] })
  ]
});

const navigationHandler = async (options: { request: Request; url: URL; event: ExtendableEvent }) => {
  try {
    const precached = await matchPrecache("/index.html");
    if (precached) return precached;
    return await navigationStrategy.handle(options);
  } catch (error) {
    console.error("[SW] Navigation request dispatch failed:", error);
    return Response.error();
  }
};

const navigationRoute = new NavigationRoute(navigationHandler, {
  denylist: [
    /^\/api\//,
    /^\/ws\//,
  ],
});

registerRoute(navigationRoute);

// High-fidelity local caching specifically for heavy media files (Audio MP3 speech tracks)
const heavyMediaStrategy = new CacheFirst({
  cacheName: "learning-audio-media",
  matchOptions: {
    ignoreVary: true,
    ignoreSearch: true,
  },
  plugins: [
    new CacheableResponsePlugin({ statuses: [0, 200] }),
    new ExpirationPlugin({
      maxEntries: 1000, 
      maxAgeSeconds: 90 * 24 * 60 * 60, // 90 days local retention for vocabulary audio packages
      purgeOnQuotaError: true,
    }),
  ],
});

registerRoute(
  ({ url }) => url.pathname.includes("/media/") || url.hostname.includes("r2.dev") || (url.hostname === "localhost" && url.port === "9000"),
  heavyMediaStrategy
);

self.addEventListener("message", (event: ExtendableMessageEvent) => {
  if (event.data && (event.data as Record<string, unknown>).type === "SKIP_WAITING") {
    void self.skipWaiting();
  }
});
