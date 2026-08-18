// ============================================================
// RESLU Spec System — messaging continuity + web push (r27)
// BUILD-SPEC.md item 2: "public/sw.js service worker (push +
// notificationclick -> link_href)."
//
// Registered globally at the default '/' scope. The fetch handler is
// intentionally narrow: immutable Next/static assets are cache-first and the
// generic /messages document is network-first with an offline fallback. API
// responses, private attachment bytes and project-specific HTML are never
// cached here. Recent conversation JSON is stored separately in a bounded,
// profile-scoped IndexedDB cache by ConversationWorkspace.
//
// Conversation pushes carry an encrypted opaque notification id and fetch
// that exact private row from RESLU. Legacy payload-less admin/health pushes
// still fetch the latest unread row. In both cases the service worker sends
// the signed-in browser's same-origin session cookie; private message content
// is never placed in the provider payload.
// ============================================================

const STATIC_CACHE = "reslu-static-v1";
const MESSAGING_SHELL_CACHE = "reslu-messaging-shell-v1";
const STATIC_PATHS = new Set([
  "/manifest.json",
  "/apple-touch-icon.png",
  "/icon-192.png",
  "/icon-512.png",
]);

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate" && url.pathname === "/messages") {
    event.respondWith((async () => {
      const cache = await caches.open(MESSAGING_SHELL_CACHE);
      const cacheKey = new Request(`${url.origin}/messages`, { credentials: "same-origin" });
      try {
        const response = await fetch(request);
        const responseUrl = new URL(response.url);
        // Never cache an authentication redirect or an error page.
        if (response.ok && responseUrl.origin === url.origin && responseUrl.pathname === "/messages") {
          await cache.put(cacheKey, response.clone());
        }
        return response;
      } catch (reason) {
        const cached = await cache.match(cacheKey);
        if (cached) return cached;
        throw reason;
      }
    })());
    return;
  }

  if (url.pathname.startsWith("/_next/static/") || STATIC_PATHS.has(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(STATIC_CACHE);
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    })());
  }
});

self.addEventListener("push", (event) => {
  let notificationRequest = fetch("/api/notifications/latest-unread", { credentials: "same-origin" });
  if (event.data) {
    try {
      const payload = event.data.json();
      if (payload && typeof payload.notification_id === "string") {
        notificationRequest = fetch(`/api/notifications/${encodeURIComponent(payload.notification_id)}`, {
          credentials: "same-origin",
        });
      }
    } catch {
      // Invalid provider data is treated like a legacy payload-less wake-up.
    }
  }
  event.waitUntil(
    notificationRequest
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        const notification = data && data.notification;
        if (!notification) return;
        return self.registration.showNotification(notification.title || "RESLU", {
          body: notification.body || "",
          data: { link: notification.link_href || "/" },
          tag: notification.tag || notification.id,
        });
      })
      .catch(() => {
        // Best-effort — a failed fetch (offline, session expired) just
        // means no notification is shown for this particular wake-up;
        // nothing here can usefully retry, and a service worker must
        // never throw out of a push handler.
      })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      const destination = new URL(link, self.location.origin);
      for (const client of windowClients) {
        const current = new URL(client.url);
        if (current.origin !== destination.origin || current.pathname !== destination.pathname) continue;
        // Reuse the existing RESLU window, but navigate it to the exact
        // conversation/message carried by the notification first.
        if ("navigate" in client) {
          return client.navigate(destination.href).then((navigated) => navigated && navigated.focus());
        }
        if ("focus" in client) return client.focus();
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(link);
      }
      return undefined;
    })
  );
});
