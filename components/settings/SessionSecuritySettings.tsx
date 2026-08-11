"use client";

import { useState } from "react";

type Outcome = "idle" | "busy" | "success" | "error";

async function currentPushEndpoint(): Promise<string | null> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return null;
  const registration = await navigator.serviceWorker.getRegistration("/");
  const subscription = await registration?.pushManager.getSubscription();
  return subscription?.endpoint ?? null;
}

export function SessionSecuritySettings() {
  const [outcome, setOutcome] = useState<Outcome>("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function revokeOtherSessions() {
    if (!window.confirm(
      "Sign out every other RESLU browser and device? This device stays signed in. Other devices may retain access only until their current short-lived access token expires."
    )) return;
    setOutcome("busy");
    setMessage(null);
    try {
      const response = await fetch("/api/me/sessions/revoke-others", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current_push_endpoint: await currentPushEndpoint() }),
      });
      const result = await response.json().catch(() => ({})) as { error?: string; sessions_revoked?: boolean };
      if (!response.ok) {
        throw new Error(result.error ?? "Other sessions could not be revoked.");
      }
      setOutcome("success");
      setMessage("Other sessions cannot renew their login, and their RESLU push routes were removed. This device remains signed in.");
    } catch (reason) {
      setOutcome("error");
      setMessage(reason instanceof Error ? reason.message : "Other sessions could not be revoked.");
    }
  }

  return (
    <div className="rounded-xl border border-[#d4cbbd] bg-white/55 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-body font-semibold text-nearblack">Other signed-in devices</p>
          <p className="mt-1 max-w-2xl text-caption leading-relaxed text-charcoal/60">
            Prevent every other browser or phone from renewing its RESLU login and remove its notification route. An access token already issued to another device can remain valid only until that short-lived token expires; this is not a remote erase of files already downloaded to that device.
          </p>
        </div>
        <button
          type="button"
          onClick={revokeOtherSessions}
          disabled={outcome === "busy"}
          className="min-h-11 shrink-0 rounded-lg border border-red-700 px-4 py-2 text-caption font-semibold text-red-800 hover:bg-red-50 disabled:opacity-40"
        >
          {outcome === "busy" ? "Signing out…" : "Sign out other devices"}
        </button>
      </div>
      {message && (
        <p className={`mt-3 text-caption ${outcome === "error" ? "text-red-700" : "text-green-800"}`} role="status" aria-live="polite">
          {message}
        </p>
      )}
    </div>
  );
}
