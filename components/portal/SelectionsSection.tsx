"use client";

import { useMemo, useState } from "react";
import clsx from "clsx";
import Image from "next/image";
import type { PortalItemWithFiles } from "@/app/portal/types";
import { PortalSection } from "@/components/portal/PortalSection";
import { SelectionsStepper } from "@/components/portal/SelectionsStepper";

const UNASSIGNED = "Other";

const FILE_KIND_LABELS: Record<string, string> = {
  spec_sheet: "Spec sheet",
  install_manual: "Install manual",
  warranty: "Warranty",
  other: "Document",
};

type FilterKey = "awaiting" | "flagged" | "approved";

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "awaiting", label: "Awaiting" },
  { key: "flagged", label: "Flagged" },
  { key: "approved", label: "Approved" },
];

function isOverdue(decisionNeededBy: string | null): boolean {
  if (!decisionNeededBy) return false;
  const today = new Date().toISOString().slice(0, 10);
  return decisionNeededBy < today;
}

function formatDeadline(d: string): string {
  return new Date(d + "T00:00:00").toLocaleDateString("en-AU", { day: "numeric", month: "long" });
}

/**
 * Selections at scale (BUILD-SPEC.md §"Phase 11 — Client portal v2 +
 * trade confirmations" point 4, "must scale to 200+ items"):
 *
 *   "progress header ('132 of 204 approved' + bar), filter chips
 *   (Awaiting/Flagged/Approved), items in compact rows (thumb, code,
 *   name, tap to expand details/images) grouped by room with 'Approve
 *   all N in this room' bulk action (confirm dialog; writes individual
 *   approval_events per item ...), and a 'Review one by one' mode —
 *   full-screen single-item stepper ... ideal on mobile. Approving via
 *   bulk never includes flagged items."
 *
 * Replaces the Week 3B/8B PortalBoard as the Selections section's
 * renderer (PortalBoard itself is left in place, untouched, in case
 * anything else references it — this component is new, additive).
 * Deadline display per §"Phase 11 additions — confirmed by Phillip"
 * point 2: "Approve by {date} to keep your design package on
 * schedule"; overdue = amber, design-phase framing only (never
 * threatens construction dates).
 */
export function SelectionsSection({
  token,
  initialItems,
}: {
  token: string;
  initialItems: PortalItemWithFiles[];
}) {
  const [items, setItems] = useState<PortalItemWithFiles[]>(initialItems);
  const [filter, setFilter] = useState<FilterKey | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [flaggingId, setFlaggingId] = useState<string | null>(null);
  const [bulkConfirmLocation, setBulkConfirmLocation] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [stepperOpen, setStepperOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const approvedCount = items.filter((i) => i.client_approved).length;
  const flaggedCount = items.filter((i) => i.client_flagged).length;
  const total = items.length;

  const filtered = useMemo(() => {
    if (!filter) return items;
    if (filter === "awaiting") return items.filter((i) => !i.client_approved && !i.client_flagged);
    if (filter === "flagged") return items.filter((i) => i.client_flagged);
    return items.filter((i) => i.client_approved);
  }, [items, filter]);

  const groups = useMemo(() => {
    const map = new Map<string, PortalItemWithFiles[]>();
    for (const it of filtered) {
      const key = it.location?.trim() || UNASSIGNED;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(it);
    }
    return [...map.entries()].sort((a, b) => {
      if (a[0] === UNASSIGNED) return 1;
      if (b[0] === UNASSIGNED) return -1;
      return a[0].localeCompare(b[0]);
    });
  }, [filtered]);

  function mergeUpdated(updated: PortalItemWithFiles[] | PortalItemWithFiles) {
    const list = Array.isArray(updated) ? updated : [updated];
    setItems((cur) =>
      cur.map((it) => {
        const match = list.find((u) => u.id === it.id);
        return match ? { ...it, ...match, files: it.files } : it;
      })
    );
  }

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
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error ?? "Something went wrong.");
      }
      const { item } = await res.json();
      mergeUpdated(item);
      setFlaggingId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusyId(null);
    }
  }

  async function bulkApprove(location: string) {
    setBulkBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/portal/${token}/bulk-approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ location }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error ?? "Could not approve this room.");
      }
      const { items: updated } = await res.json();
      mergeUpdated(updated);
      setBulkConfirmLocation(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not approve this room.");
    } finally {
      setBulkBusy(false);
    }
  }

  if (items.length === 0) {
    return (
      <PortalSection id="selections" title="Selections">
        <div className="border border-dashed border-[#c9c2b4] p-12 text-center">
          <p className="text-body text-charcoal/60">There are no items to review yet. Please check back soon.</p>
        </div>
      </PortalSection>
    );
  }

  return (
    <PortalSection id="selections" title="Selections">
      {/* Progress header + bar */}
      <div className="mb-4">
        <div className="flex items-baseline justify-between">
          <p className="text-subhead text-nearblack">
            {approvedCount} of {total} approved
          </p>
          <button
            type="button"
            onClick={() => setStepperOpen(true)}
            className="label-caps !text-sand hover:!text-nearblack"
          >
            Review one by one
          </button>
        </div>
        <div className="mt-2 h-1.5 w-full bg-[#e5e0d6]">
          <div
            className="h-1.5 bg-sand transition-all"
            style={{ width: `${total > 0 ? (approvedCount / total) * 100 : 0}%` }}
          />
        </div>
      </div>

      {/* Filter chips */}
      <div className="mb-6 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setFilter(null)}
          className={clsx(
            "label-caps border px-3 py-1.5",
            !filter ? "border-nearblack !text-nearblack" : "border-[#dcd6cc] !text-charcoal/50 hover:!text-nearblack"
          )}
        >
          All ({total})
        </button>
        {FILTERS.map((f) => {
          const count = f.key === "awaiting" ? total - approvedCount - flaggedCount : f.key === "flagged" ? flaggedCount : approvedCount;
          return (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={clsx(
                "label-caps border px-3 py-1.5",
                filter === f.key ? "border-nearblack !text-nearblack" : "border-[#dcd6cc] !text-charcoal/50 hover:!text-nearblack"
              )}
            >
              {f.label} ({count})
            </button>
          );
        })}
      </div>

      {error && (
        <p className="mb-4 border border-red-700/40 bg-red-50 px-3 py-2 text-body text-red-700">{error}</p>
      )}

      <div className="space-y-8">
        {groups.map(([location, groupItems]) => {
          const approvableCount = groupItems.filter((i) => !i.client_approved && !i.client_flagged).length;
          return (
            <section key={location}>
              <div className="mb-3 flex items-center justify-between border-b border-nearblack bg-cream px-1 pb-2 pt-3">
                <h3 className="label-caps">{location}</h3>
                {approvableCount > 0 && (
                  <button
                    type="button"
                    onClick={() => setBulkConfirmLocation(location)}
                    className="label-caps !text-sand hover:!text-nearblack"
                  >
                    Approve all {approvableCount} in this room
                  </button>
                )}
              </div>

              {bulkConfirmLocation === location && (
                <div className="mb-3 border border-sand bg-offwhite p-3">
                  <p className="text-body text-charcoal/80">
                    Approve all {approvableCount} remaining item{approvableCount === 1 ? "" : "s"} in {location}? Flagged items are never
                    included.
                  </p>
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      disabled={bulkBusy}
                      onClick={() => bulkApprove(location)}
                      className="bg-nearblack px-4 py-2 text-subhead text-white hover:bg-charcoal disabled:opacity-60"
                    >
                      {bulkBusy ? "Approving…" : "Confirm approve all"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setBulkConfirmLocation(null)}
                      className="px-3 py-2 text-subhead text-charcoal/60 hover:text-nearblack"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              <div className="space-y-2">
                {groupItems.map((item) => {
                  const expanded = expandedId === item.id;
                  const overdue = isOverdue(item.decision_needed_by);
                  return (
                    <article
                      key={item.id}
                      className={clsx(
                        "border",
                        item.client_approved
                          ? "border-sand bg-offwhite"
                          : item.client_flagged
                            ? "border-red-700/40 bg-red-50/40"
                            : "border-[#dcd6cc] bg-nearwhite"
                      )}
                    >
                      {/* Compact row — thumb, code, name, tap to expand */}
                      <button
                        type="button"
                        onClick={() => setExpandedId(expanded ? null : item.id)}
                        className="flex w-full items-center gap-3 p-3 text-left"
                      >
                        {item.selected_image_url ? (
                          <div className="relative h-12 w-12 shrink-0 overflow-hidden bg-cream">
                            <Image src={item.selected_image_url} alt="" fill sizes="48px" className="object-cover" />
                          </div>
                        ) : (
                          <div className="h-12 w-12 shrink-0 bg-cream" />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline gap-2">
                            <span className="label-caps shrink-0">{item.item_code}</span>
                            <span className="truncate text-body text-nearblack">{item.name}</span>
                          </div>
                          {item.decision_needed_by && !item.client_approved && (
                            <p className={clsx("mt-0.5 text-caption", overdue ? "text-amber-700" : "text-charcoal/50")}>
                              Approve by {formatDeadline(item.decision_needed_by)} to keep your design package on schedule
                            </p>
                          )}
                        </div>
                        <span className="shrink-0 text-caption text-charcoal/40">{expanded ? "−" : "+"}</span>
                      </button>

                      {expanded && (
                        <div className="border-t border-[#e5e0d6] p-4">
                          {item.description && <p className="text-body text-charcoal/70">{item.description}</p>}
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

                          {item.files.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                              {item.files.map((f) => (
                                <a
                                  key={f.id}
                                  href={f.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-body text-nearblack underline decoration-sand underline-offset-2 hover:decoration-nearblack"
                                >
                                  {FILE_KIND_LABELS[f.kind] ?? "Document"}
                                </a>
                              ))}
                            </div>
                          )}

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
                                    item.client_approved ? "bg-sand text-white" : "bg-nearblack text-white hover:bg-charcoal"
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
                      )}
                    </article>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>

      {stepperOpen && (
        <SelectionsStepper
          token={token}
          items={items}
          onUpdate={(item) => mergeUpdated(item)}
          onClose={() => setStepperOpen(false)}
        />
      )}
    </PortalSection>
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
        <button type="button" onClick={onCancel} className="px-4 py-2 text-subhead text-charcoal/60 hover:text-nearblack">
          Cancel
        </button>
      </div>
    </div>
  );
}
