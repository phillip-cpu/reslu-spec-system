"use client";

import { useState } from "react";
import clsx from "clsx";

interface VariationRow {
  id: string;
  var_number: number;
  description: string;
  cost_ex_gst: number;
  status: string;
  share_to_portal: boolean;
  client_response: "approved" | "declined" | null;
  client_response_note: string | null;
  client_responded_at: string | null;
}

const CURRENCY = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" });
const GST_RATE = 0.1;

/**
 * Variation sharing panel (BUILD-SPEC.md "Team-side client area":
 * "variation sharing (list variations with share toggle + response
 * status)"). The share TOGGLE is admin-only — "it exposes client
 * pricing decisions" — enforced server-side in PATCH
 * .../variations/[variationId]/share (the real boundary); this
 * component additionally disables the control for non-admins so the
 * UI doesn't invite a request that will just 403, matching the
 * financial-visibility pattern used elsewhere (hidden/disabled in UI
 * AND independently enforced server-side, never UI-only).
 */
export function VariationSharingPanel({
  projectId,
  variations: initial,
  isAdmin,
  onChange,
}: {
  projectId: string;
  variations: VariationRow[];
  isAdmin: boolean;
  onChange: () => void;
}) {
  const [variations, setVariations] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function toggleShare(id: string, share: boolean) {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/client-updates/variations/${id}/share`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ share_to_portal: share }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not update sharing");
      const { variation } = await res.json();
      setVariations((cur) => cur.map((v) => (v.id === id ? { ...v, ...variation } : v)));
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update sharing");
    } finally {
      setBusyId(null);
    }
  }

  if (variations.length === 0) {
    return <p className="text-body text-charcoal/50">No variations recorded for this project yet.</p>;
  }

  return (
    <div className="space-y-4">
      {!isAdmin && (
        <p className="border border-[#dcd6cc] bg-nearwhite px-4 py-2 text-body text-charcoal/60">
          Only admins can change what&apos;s shared to the client portal — it exposes client
          pricing decisions.
        </p>
      )}
      {error && (
        <p className="border border-red-700/40 bg-red-50 px-4 py-2 text-body text-red-700">{error}</p>
      )}

      <ul className="space-y-2">
        {variations.map((v) => (
          <li key={v.id} className="flex flex-col gap-2 border border-[#e5e0d6] bg-nearwhite px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-subhead text-nearblack">
                #{v.var_number} — {v.description}
              </p>
              <p className="text-caption text-charcoal/50">
                {CURRENCY.format(v.cost_ex_gst)} ex GST · {CURRENCY.format(v.cost_ex_gst * (1 + GST_RATE))} inc GST · {v.status}
              </p>
              {v.client_response && (
                <p
                  className={clsx(
                    "text-caption",
                    v.client_response === "approved" ? "text-sand" : "text-red-700"
                  )}
                >
                  Client {v.client_response}
                  {v.client_response_note ? `: "${v.client_response_note}"` : ""}
                </p>
              )}
            </div>
            <label className="flex shrink-0 items-center gap-2 text-caption text-charcoal/70">
              <input
                type="checkbox"
                checked={v.share_to_portal}
                disabled={!isAdmin || busyId === v.id}
                onChange={(e) => toggleShare(v.id, e.target.checked)}
              />
              Share to portal
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}
