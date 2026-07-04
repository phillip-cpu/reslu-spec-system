"use client";

import { useState } from "react";
import clsx from "clsx";
import type { PortalVariation } from "@/app/portal/types";
import { PortalSection } from "@/components/portal/PortalSection";

const CURRENCY = new Intl.NumberFormat("en-AU", {
  style: "currency",
  currency: "AUD",
});

/**
 * Variations section (BUILD-SPEC.md "Week 8 — Client portal
 * expansion": "Variations (variations where share_to_portal:
 * description, cost inc GST — THE deliberate pricing exception per
 * spec, Approve/Decline buttons with note dialog → POST
 * .../variation/[id]/respond)"). This is the ONE place on the whole
 * portal that shows a price — cost_inc_gst, never cost_ex_gst, and
 * never any item-level price_trade/price_rrp/markup.
 */
export function VariationsSection({
  token,
  initialVariations,
}: {
  token: string;
  initialVariations: PortalVariation[];
}) {
  const [variations, setVariations] = useState(initialVariations);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [decliningId, setDecliningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function respond(id: string, response: "approved" | "declined", note?: string) {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/portal/${token}/variation/${id}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response, note }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Something went wrong.");
      }
      const { variation } = await res.json();
      setVariations((cur) => cur.map((v) => (v.id === id ? { ...v, ...variation } : v)));
      setDecliningId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusyId(null);
    }
  }

  if (variations.length === 0) {
    return (
      <PortalSection id="variations" title="Variations">
        <p className="text-body text-charcoal/50">There are no variations to review.</p>
      </PortalSection>
    );
  }

  return (
    <PortalSection id="variations" title="Variations">
      {error && (
        <p className="mb-4 border border-red-700/40 bg-red-50 px-3 py-2 text-body text-red-700">
          {error}
        </p>
      )}
      <div className="space-y-4">
        {variations.map((v) => (
          <article
            key={v.id}
            className={clsx(
              "border p-4",
              v.client_response === "approved"
                ? "border-sand bg-offwhite"
                : v.client_response === "declined"
                  ? "border-red-700/40 bg-red-50/40"
                  : "border-[#dcd6cc] bg-nearwhite"
            )}
          >
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="text-subhead text-nearblack">Variation #{v.var_number}</h3>
              <span className="text-subhead text-nearblack">{CURRENCY.format(v.cost_inc_gst)} inc GST</span>
            </div>
            <p className="mt-1 text-body text-charcoal/70">{v.description}</p>
            <p className="mt-1 text-caption text-charcoal/40">
              {new Date(v.var_date).toLocaleDateString("en-AU")}
            </p>

            {v.client_response && v.client_response_note && (
              <p className="mt-2 border-l-2 border-charcoal/20 pl-2 text-body text-charcoal/70">
                Your note: {v.client_response_note}
              </p>
            )}

            <div className="mt-3">
              {v.client_response ? (
                <span
                  className={clsx(
                    "label-caps inline-block px-3 py-1.5",
                    v.client_response === "approved" ? "bg-sand text-white" : "border border-red-700/40 text-red-700"
                  )}
                >
                  {v.client_response}
                </span>
              ) : decliningId === v.id ? (
                <DeclineForm
                  busy={busyId === v.id}
                  onCancel={() => setDecliningId(null)}
                  onSubmit={(note) => respond(v.id, "declined", note)}
                />
              ) : (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={busyId === v.id}
                    onClick={() => respond(v.id, "approved")}
                    className="bg-nearblack px-4 py-2 text-subhead text-white transition-colors hover:bg-charcoal disabled:opacity-60"
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    disabled={busyId === v.id}
                    onClick={() => setDecliningId(v.id)}
                    className="border border-charcoal/40 px-4 py-2 text-subhead text-charcoal transition-colors hover:border-nearblack disabled:opacity-60"
                  >
                    Decline
                  </button>
                </div>
              )}
            </div>
          </article>
        ))}
      </div>
    </PortalSection>
  );
}

function DeclineForm({
  busy,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  onCancel: () => void;
  onSubmit: (note: string) => void;
}) {
  const [note, setNote] = useState("");
  return (
    <div className="space-y-2">
      <textarea
        autoFocus
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Let us know why (optional)"
        rows={2}
        className="w-full border border-[#c9c2b4] bg-nearwhite px-3 py-2 text-body focus:border-nearblack focus:outline-none"
      />
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => onSubmit(note)}
          className="bg-nearblack px-4 py-2 text-subhead text-white hover:bg-charcoal disabled:opacity-60"
        >
          {busy ? "Sending…" : "Confirm decline"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-subhead text-charcoal/60 hover:text-nearblack"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
