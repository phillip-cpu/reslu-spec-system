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
// Conversation pushes carry an encrypted opaque notification id and fetch
// that exact private row from RESLU. Legacy payload-less admin/health pushes
// still fetch the latest unread row. In both cases the service worker sends
// the signed-in browser's same-origin session cookie; private message content
// is never placed in the provider payload.
// ============================================================

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
