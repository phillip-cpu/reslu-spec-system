"use client";

import { useMemo, useState } from "react";
import clsx from "clsx";
import Image from "next/image";
import type { PortalItem } from "@/types";

const UNASSIGNED = "Other";

interface Props {
  token: string;
  initialItems: PortalItem[];
}

export function PortalBoard({ token, initialItems }: Props) {
  const [items, setItems] = useState<PortalItem[]>(initialItems);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [flaggingId, setFlaggingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const groups = useMemo(() => {
    const map = new Map<string, PortalItem[]>();
    for (const it of items) {
      const key = it.location?.trim() || UNASSIGNED;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(it);
    }
    return [...map.entries()].sort((a, b) => {
      if (a[0] === UNASSIGNED) return 1;
      if (b[0] === UNASSIGNED) return -1;
      return a[0].localeCompare(b[0]);
    });
  }, [items]);

  const approvedCount = items.filter((i) => i.client_approved).length;
  const flaggedCount = items.filter((i) => i.client_flagged).length;

  async function act(id: string, action: "approve" | "flag", note?: string) {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/portal/${token}/${action}/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Something went wrong.");
      }
      const { item } = await res.json();
      setItems((cur) => cur.map((it) => (it.id === id ? item : it)));
      setFlaggingId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusyId(null);
    }
  }

  if (items.length === 0) {
    return (
      <div className="border border-dashed border-[#c9c2b4] p-12 text-center">
        <p className="text-body text-charcoal/60">
          There are no items to review yet. Please check back soon.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex gap-6 border-b border-[#dcd6cc] pb-4 text-body text-charcoal/70">
        <span>{items.length} items</span>
        <span>{approvedCount} approved</span>
        <span>{flaggedCount} flagged</span>
      </div>

      {error && (
        <p className="border border-red-700/40 bg-red-50 px-3 py-2 text-body text-red-700">
          {error}
        </p>
      )}

      {groups.map(([location, groupItems]) => (
        <section key={location}>
          <h2 className="label-caps mb-3 border-b border-nearblack pb-1 !text-nearblack">
            {location}
          </h2>
          <div className="space-y-4">
            {groupItems.map((item) => (
              <article
                key={item.id}
                className={clsx(
                  "flex flex-col gap-4 border p-4 sm:flex-row",
                  item.client_approved
                    ? "border-sand bg-offwhite"
                    : item.client_flagged
                      ? "border-red-700/40 bg-red-50/40"
                      : "border-[#dcd6cc] bg-nearwhite"
                )}
              >
                {item.selected_image_url && (
                  <div className="relative h-40 w-full shrink-0 overflow-hidden bg-cream sm:h-32 sm:w-32">
                    <Image
                      src={item.selected_image_url}
                      alt={item.name}
                      fill
                      sizes="128px"
                      className="object-cover"
                    />
                  </div>
                )}

                <div className="flex-1">
                  <div className="flex items-baseline justify-between gap-3">
                    <h3 className="text-subhead text-nearblack">{item.name}</h3>
                    <span className="label-caps shrink-0">{item.item_code}</span>
                  </div>
                  {item.description && (
                    <p className="mt-1 text-body text-charcoal/70">
                      {item.description}
                    </p>
                  )}
                  <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-body text-charcoal/60">
                    {item.supplier && <span>{item.supplier}</span>}
                    <span>Qty {item.quantity}</span>
                    <span>{item.status}</span>
                  </div>

                  {item.client_flagged && item.client_flag_note && (
                    <p className="mt-2 border-l-2 border-red-700/40 pl-2 text-body text-charcoal/70">
                      Your note: {item.client_flag_note}
                    </p>
                  )}

                  {/* Actions */}
                  <div className="mt-3">
                    {flaggingId === item.id ? (
                      <FlagForm
                        busy={busyId === item.id}
                        onCancel={() => setFlaggingId(null)}
                        onSubmit={(note) => act(item.id, "flag", note)}
                      />
                    ) : (
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={busyId === item.id}
                          onClick={() => act(item.id, "approve")}
                          className={clsx(
                            "px-4 py-2 text-subhead transition-colors disabled:opacity-60",
                            item.client_approved
                              ? "bg-sand text-white"
                              : "bg-nearblack text-white hover:bg-charcoal"
                          )}
                        >
                          {item.client_approved ? "Approved ✓" : "Approve"}
                        </button>
                        <button
                          type="button"
                          disabled={busyId === item.id}
                          onClick={() => setFlaggingId(item.id)}
                          className="border border-charcoal/40 px-4 py-2 text-subhead text-charcoal transition-colors hover:border-nearblack disabled:opacity-60"
                        >
                          {item.client_flagged ? "Flagged — edit" : "Flag a change"}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </article>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function FlagForm({
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
        placeholder="What would you like changed? (optional)"
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
          {busy ? "Sending…" : "Submit flag"}
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
