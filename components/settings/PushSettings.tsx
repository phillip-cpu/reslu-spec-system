"use client";

import { useEffect, useState } from "react";

// ============================================================
// RESLU Spec System — Health + web push (r26)
// BUILD-SPEC.md item 2: "public/sw.js service worker registered ...
// subscribe/unsubscribe toggle in Settings ... register /sw.js at app
// scope from THIS component only (no root layout edit unless
// required; document if required)."
//
// NOT REQUIRED: this round did not touch app/layout.tsx. Registration
// happens lazily, only when a user actually presses "Enable push" (or
// on mount IF a subscription already exists, to keep the toggle's
// displayed state accurate across reloads) — never unconditionally on
// every page load, so a user who never visits Settings never has a
// service worker registered against their session at all. Scope is
// the default ('/', the directory sw.js is served from, i.e. the
// whole app) — no explicit `{ scope: ... }` needed since public/sw.js
// sits at the root.
// ============================================================

const NOT_CONFIGURED = "Push isn't configured yet (missing NEXT_PUBLIC_VAPID_PUBLIC_KEY).";

/** Standard Push API helper — converts the base64url VAPID public key into the Uint8Array applicationServerKey expects. */
// Return type pinned to Uint8Array<ArrayBuffer> (not the bare
// `Uint8Array` alias, which TS 5.7+'s lib.dom widens to
// Uint8Array<ArrayBufferLike>) — pushManager.subscribe's
// applicationServerKey wants BufferSource, which requires the
// ArrayBuffer-backed generic specifically.
function urlBase64ToUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

type Status = "unsupported" | "not_configured" | "checking" | "subscribed" | "unsubscribed" | "denied";

export function PushSettings() {
  const [status, setStatus] = useState<Status>("checking");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const vapidPublicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

  useEffect(() => {
    let cancelled = false;

    async function checkStatus() {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        if (!cancelled) setStatus("unsupported");
        return;
      }
      if (!vapidPublicKey) {
        if (!cancelled) setStatus("not_configured");
        return;
      }
      if (Notification.permission === "denied") {
        if (!cancelled) setStatus("denied");
        return;
      }
      try {
        const registration = await navigator.serviceWorker.getRegistration("/");
        const existing = await registration?.pushManager.getSubscription();
        if (!cancelled) setStatus(existing ? "subscribed" : "unsubscribed");
      } catch {
        if (!cancelled) setStatus("unsubscribed");
      }
    }

    checkStatus();
    return () => {
      cancelled = true;
    };
  }, [vapidPublicKey]);

  async function enable() {
    if (!vapidPublicKey) return;
    setBusy(true);
    setError(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setStatus("denied");
        return;
      }
      const registration = await navigator.serviceWorker.register("/sw.js");
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      });
      const res = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(subscription.toJSON()),
      });
      if (!res.ok) throw new Error("Could not save subscription on the server.");
      setStatus("subscribed");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not enable push notifications.");
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    setError(null);
    try {
      const registration = await navigator.serviceWorker.getRegistration("/");
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        await fetch("/api/push/unsubscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        });
        await subscription.unsubscribe();
      }
      setStatus("unsubscribed");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not disable push notifications.");
    } finally {
      setBusy(false);
    }
  }

  if (status === "unsupported") {
    return <p className="text-body text-charcoal/60">Push notifications aren&apos;t supported in this browser.</p>;
  }
  if (status === "not_configured") {
    return <p className="text-body text-charcoal/60">{NOT_CONFIGURED}</p>;
  }

  return (
    <div>
      <div className="flex items-center gap-3">
        {status === "checking" ? (
          <p className="text-body text-charcoal/60">Checking status…</p>
        ) : status === "subscribed" ? (
          <>
            <span className="label-caps text-charcoal">Enabled on this device</span>
            <button
              type="button"
              onClick={disable}
              disabled={busy}
              className="border border-charcoal/40 px-3 py-1.5 text-caption text-charcoal hover:border-nearblack hover:text-nearblack disabled:opacity-40"
            >
              {busy ? "…" : "Turn off"}
            </button>
          </>
        ) : status === "denied" ? (
          <span className="text-body text-charcoal/60">
            Notifications are blocked for this site in your browser settings — enable them there to turn push back on.
          </span>
        ) : (
          <button
            type="button"
            onClick={enable}
            disabled={busy}
            className="border border-nearblack bg-nearblack px-4 py-2 text-subhead text-white hover:opacity-90 disabled:opacity-40"
          >
            {busy ? "Enabling…" : "Enable push notifications"}
          </button>
        )}
      </div>
      {error && <p className="mt-2 text-caption text-red-700">{error}</p>}
    </div>
  );
}
