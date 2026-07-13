// ============================================================
// RESLU Spec System — Health + web push (r26)
// BUILD-SPEC.md item 2: "public/sw.js service worker (push +
// notificationclick -> link_href)."
//
// Registered ONLY from components/settings/PushSettings.tsx (the
// Settings -> Push notifications section), at the default '/' scope —
// no root layout change was needed/made (see that component's own
// header comment). This file is otherwise unremarkable: it does NOT
// cache anything (no 'install'/'activate'/'fetch' handlers) — its only
// job is to react to a push event and a notification click. Keeping it
// this narrow avoids accidentally turning it into an offline-cache
// service worker, which is a separate, much larger feature this round
// never asked for.
//
// Payload-less push (BUILD-SPEC.md item 2): the push event itself
// carries no data (see lib/push.ts's own header comment for why) — on
// 'push', this fetches the one row that push woke it up to go get,
// GET /api/notifications/latest-unread, and shows THAT as the browser
// notification. `credentials: 'same-origin'` is set explicitly (it is
// also fetch's own default for a same-origin request, but a push
// event's fetch runs with no "current page" for context, so this is
// spelled out rather than relied on implicitly) — the route reads the
// caller's Supabase session cookie the exact same way every other
// authenticated route in this app does (lib/supabase/server.ts's
// createClient()), nothing push-specific on the auth side at all.
// ============================================================

self.addEventListener("push", (event) => {
  event.waitUntil(
    fetch("/api/notifications/latest-unread", { credentials: "same-origin" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        const notification = data && data.notification;
        if (!notification) return;
        return self.registration.showNotification(notification.title || "RESLU", {
          body: notification.body || "",
          data: { link: notification.link_href || "/" },
          tag: notification.id,
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
      for (const client of windowClients) {
        // Focus an already-open tab on the same link rather than
        // opening a duplicate one.
        if (client.url.endsWith(link) && "focus" in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(link);
      }
      return undefined;
    })
  );
});
