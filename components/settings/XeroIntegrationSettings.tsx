"use client";

import { useState } from "react";
import type { XeroConnectionStatus } from "@/types/xero";

const NOTICE: Record<string, string> = {
  connected: "Xero connected successfully.",
  invalid_state: "The Xero sign-in expired or could not be verified. Please try again.",
  tenant_selection_required:
    "More than one Xero organisation is authorised. Set XERO_TENANT_ID to the RESLU tenant, then connect again.",
  connection_failed: "Xero could not be connected. Check the server logs and app credentials.",
};

function formatDate(value: string | null): string {
  if (!value) return "Never";
  return new Intl.DateTimeFormat("en-AU", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function XeroIntegrationSettings({
  initialStatus,
  callbackUrl,
  notice,
}: {
  initialStatus: XeroConnectionStatus;
  callbackUrl: string;
  notice?: string;
}) {
  const [status, setStatus] = useState(initialStatus);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<string | null>(notice ? NOTICE[notice] ?? null : null);

  async function syncNow() {
    setSyncing(true);
    setMessage(null);
    try {
      const response = await fetch("/api/xero/sync", { method: "POST" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Xero sync failed");
      setStatus(body.status as XeroConnectionStatus);
      setMessage(
        `Xero sync complete: ${body.result.invoices_checked} invoices and ${body.result.payments_checked} payments checked.`
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Xero sync failed");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="max-w-2xl border border-[#dcd6cc] bg-offwhite">
      <div className="flex flex-wrap items-start justify-between gap-4 px-4 py-4">
        <div>
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className={`h-2.5 w-2.5 ${status.connected ? "bg-emerald-600" : "bg-charcoal/25"}`}
            />
            <h3 className="text-body text-nearblack">Xero accounting</h3>
          </div>
          <p className="mt-1 text-caption text-charcoal/55">
            Read-only invoice, purchase-bill and payment reconciliation.
          </p>
        </div>
        {status.configured && !status.connected && (
          <a
            href="/api/xero/connect"
            className="bg-nearblack px-4 py-2 text-subhead text-white hover:bg-charcoal"
          >
            Connect Xero
          </a>
        )}
        {status.connected && (
          <button
            type="button"
            onClick={syncNow}
            disabled={syncing}
            className="bg-nearblack px-4 py-2 text-subhead text-white hover:bg-charcoal disabled:opacity-50"
          >
            {syncing ? "Syncing…" : "Sync now"}
          </button>
        )}
      </div>

      {!status.configured ? (
        <div className="border-t border-[#e5e0d6] px-4 py-4 text-body text-charcoal/65">
          <p>Server credentials are not configured yet.</p>
          <p className="mt-2 text-caption">
            Create the Xero OAuth app with callback URL <code>{callbackUrl}</code>, then add the
            Xero environment variables in Vercel.
          </p>
        </div>
      ) : status.connected ? (
        <dl className="grid gap-4 border-t border-[#e5e0d6] px-4 py-4 text-body sm:grid-cols-2">
          <div>
            <dt className="label-caps !text-charcoal/50">Organisation</dt>
            <dd className="mt-1 text-nearblack">{status.tenant_name}</dd>
          </div>
          <div>
            <dt className="label-caps !text-charcoal/50">Last sync</dt>
            <dd className="mt-1 text-nearblack">{formatDate(status.last_sync_completed_at)}</dd>
          </div>
          <div>
            <dt className="label-caps !text-charcoal/50">Cached records</dt>
            <dd className="mt-1 text-nearblack">
              {status.invoice_count} invoices · {status.payment_count} payments
            </dd>
          </div>
          <div>
            <dt className="label-caps !text-charcoal/50">Access</dt>
            <dd className="mt-1 text-nearblack">Read only</dd>
          </div>
        </dl>
      ) : (
        <p className="border-t border-[#e5e0d6] px-4 py-4 text-body text-charcoal/60">
          Credentials are configured. Authorise the RESLU Xero organisation to begin.
        </p>
      )}

      {(message || status.last_sync_error) && (
        <p className="border-t border-[#e5e0d6] px-4 py-3 text-caption text-charcoal/65">
          {message ?? status.last_sync_error}
        </p>
      )}
    </div>
  );
}
