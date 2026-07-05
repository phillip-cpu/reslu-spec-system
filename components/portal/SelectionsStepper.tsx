"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import type { PortalItemWithFiles } from "@/app/portal/types";

/**
 * "Review one by one" mode (BUILD-SPEC.md §"Selections (FF&E
 * approvals)"): "a 'Review one by one' mode — full-screen single-item
 * stepper (image, details, Approve/Flag/Skip, auto-advance) ideal on
 * mobile."
 *
 * Only steps through NOT-yet-decided items (not already approved or
 * flagged) — reviewing something already resolved has no purpose here.
 * "Skip" just advances without acting, for a "come back to this one
 * later" pass. Progress shown as "34 of 68" per the spec's own example
 * text.
 */
export function SelectionsStepper({
  token,
  items,
  onUpdate,
  onClose,
}: {
  token: string;
  items: PortalItemWithFiles[];
  onUpdate: (item: PortalItemWithFiles) => void;
  onClose: () => void;
}) {
  const queue = useMemo(() => items.filter((i) => !i.client_approved && !i.client_flagged), [items]);
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [flagging, setFlagging] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const current = queue[index];
  const total = queue.length;

  function advance() {
    setFlagging(false);
    setNote("");
    setError(null);
    setIndex((i) => Math.min(i + 1, total));
  }

  async function act(action: "approve" | "flag") {
    if (!current) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/portal/${token}/${action}/${current.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: action === "flag" ? note : undefined }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error ?? "Something went wrong.");
      }
      const { item } = await res.json();
      onUpdate({ ...current, ...item });
      advance();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-30 flex flex-col bg-cream">
      <div className="flex items-center justify-between border-b border-[#dcd6cc] px-4 py-3">
        <span className="label-caps !text-sand">
          {total > 0 && index < total ? `${index + 1} of ${total}` : "All reviewed"}
        </span>
        <button type="button" onClick={onClose} className="text-subhead text-charcoal/60 hover:text-nearblack">
          Close
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-6">
        {!current ? (
          <div className="mx-auto max-w-md pt-16 text-center">
            <p className="font-display text-section text-nearblack">All done</p>
            <p className="mt-2 text-body text-charcoal/60">You&apos;ve been through every awaiting item.</p>
            <button
              type="button"
              onClick={onClose}
              className="mt-6 bg-nearblack px-6 py-3 text-subhead text-white hover:bg-charcoal"
            >
              Back to selections
            </button>
          </div>
        ) : (
          <div className="mx-auto max-w-md">
            {current.selected_image_url && (
              <div className="relative aspect-square w-full overflow-hidden bg-nearwhite">
                <Image src={current.selected_image_url} alt={current.name} fill sizes="400px" className="object-contain" />
              </div>
            )}

            <div className="mt-4">
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="text-subhead text-nearblack">{current.name}</h3>
                <span className="label-caps shrink-0">{current.item_code}</span>
              </div>
              {current.location && <p className="text-caption text-charcoal/50">{current.location}</p>}
              {current.description && <p className="mt-2 text-body text-charcoal/70">{current.description}</p>}
              <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-body text-charcoal/60">
                {current.supplier && <span>{current.supplier}</span>}
                <span>Qty {current.quantity}</span>
              </div>
            </div>

            {error && (
              <p className="mt-4 border border-red-700/40 bg-red-50 px-3 py-2 text-body text-red-700">{error}</p>
            )}

            {flagging && (
              <div className="mt-4 space-y-2">
                <textarea
                  autoFocus
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="What would you like changed? (optional)"
                  rows={2}
                  className="w-full border border-[#c9c2b4] bg-nearwhite px-3 py-2 text-body focus:border-nearblack focus:outline-none"
                />
              </div>
            )}
          </div>
        )}
      </div>

      {current && (
        <div className="border-t border-[#dcd6cc] px-4 py-4">
          <div className="mx-auto grid max-w-md grid-cols-3 gap-2">
            {flagging ? (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => act("flag")}
                  className="col-span-2 bg-nearblack py-4 text-subhead text-white hover:bg-charcoal disabled:opacity-60"
                >
                  {busy ? "Sending…" : "Submit flag"}
                </button>
                <button
                  type="button"
                  onClick={() => setFlagging(false)}
                  className="border border-charcoal/40 py-4 text-subhead text-charcoal hover:border-nearblack"
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => act("approve")}
                  className="bg-nearblack py-4 text-subhead text-white hover:bg-charcoal disabled:opacity-60"
                >
                  Approve
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setFlagging(true)}
                  className="border border-charcoal/40 py-4 text-subhead text-charcoal hover:border-nearblack disabled:opacity-60"
                >
                  Flag
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={advance}
                  className="border border-charcoal/20 py-4 text-subhead text-charcoal/60 hover:border-nearblack disabled:opacity-60"
                >
                  Skip
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
