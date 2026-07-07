"use client";

import { useMemo, useState } from "react";
import clsx from "clsx";
import Image from "next/image";
import type { PortalItemWithFiles } from "@/app/portal/types";
import { SelectionsStepper } from "@/components/portal/SelectionsStepper";
import { renditionUrl, RENDITION_SIZES } from "@/lib/image-url";

const UNASSIGNED = "Other";

const FILE_KIND_LABELS: Record<string, string> = {
  spec_sheet: "Spec sheet",
  install_manual: "Install manual",
  warranty: "Warranty",
  other: "Document",
};

export type AwaitingFlaggedFilter = "awaiting" | "flagged";

function isOverdue(decisionNeededBy: string | null): boolean {
  if (!decisionNeededBy) return false;
  const today = new Date().toISOString().slice(0, 10);
  return decisionNeededBy < today;
}

function formatDeadline(d: string): string {
  return new Date(d + "T00:00:00").toLocaleDateString("en-AU", { day: "numeric", month: "long" });
}

/**
 * Room-grouped Awaiting/Flagged item list, with expand-to-details,
 * approve/flag, bulk "Approve all N in this room", and the full-screen
 * "Review one by one" stepper — BUILD-SPEC.md §"Selections (FF&E
 * approvals)" / §"Portal selections separation" (Quick items round, 6
 * July 2026, "stronger cut").
 *
 * This is the exact rendering `components/portal/SelectionsSection.tsx`
 * used to own directly on the main portal page before this round moved
 * ALL item-level selection rendering to the /selections sub-page —
 * moved here essentially unchanged (same markup, same
 * approve/flag/bulk/stepper network calls and optimistic-update
 * behaviour, same per-item `approval_events` audit trail via the
 * unchanged API routes) so nothing about the actual approve/flag
 * behaviour regresses, only where it lives in the component tree.
 *
 * All item state (approve/flag/optimistic updates) is owned by the
 * PARENT (app/portal/[token]/selections/page.tsx's SelectionsWorkspace
 * client component) and passed down as `items` + `onUpdate` — this
 * component itself is stateless w.r.t. item data, so switching between
 * the Awaiting/Flagged/Approved tabs never loses an in-flight optimistic
 * update or duplicates the "moved to Your selections" note. `filter`
 * picks which facet of `items` this instance renders (its parent
 * renders one instance per tab, filtered accordingly, or reuses one
 * instance across tab switches — see the sub-page for which).
 */
export function AwaitingFlaggedList({
  token,
  items,
  filter,
  justApprovedIds,
  onUpdate,
  onDismissApprovedNote,
}: {
  token: string;
  items: PortalItemWithFiles[];
  filter: AwaitingFlaggedFilter;
  justApprovedIds: Set<string>;
  onUpdate: (updated: PortalItemWithFiles[] | PortalItemWithFiles) => void;
  onDismissApprovedNote: (id: string) => void;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [flaggingId, setFlaggingId] = useState<string | null>(null);
  // Tracks which group's confirm dialog is open, by group KEY (room id,
  // or "unassigned" — not the roomId directly, since roomId is itself
  // `null` for the Unassigned bucket and would be indistinguishable
  // from "no dialog open").
  const [bulkConfirmKey, setBulkConfirmKey] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [stepperOpen, setStepperOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsDecision = items.filter((i) => !i.client_approved || justApprovedIds.has(i.id));

  const filtered = useMemo(() => {
    if (filter === "awaiting") return needsDecision.filter((i) => !i.client_approved && !i.client_flagged);
    return needsDecision.filter((i) => i.client_flagged);
  }, [needsDecision, filter]);

  // Bug fix, 7 July 2026: groups by the item's REAL room assignment(s)
  // (item_rooms, via the `rooms` field) rather than the stale
  // items.location column — see lib/portal-rooms.ts's doc comment.
  // An item in multiple rooms appears in each of its room's groups
  // (same convention as the internal Spec register's "Group by Room").
  // roomId is null for the Unassigned bucket — carried through to
  // bulkApprove() below so the confirm/approve call targets real rows
  // instead of a display-only label string.
  const groups = useMemo(() => {
    const map = new Map<string, { name: string; roomId: string | null; items: PortalItemWithFiles[] }>();
    for (const it of filtered) {
      const rooms = it.rooms.length > 0 ? it.rooms : [{ id: "", name: UNASSIGNED }];
      for (const room of rooms) {
        const key = room.id || "unassigned";
        if (!map.has(key)) map.set(key, { name: room.name, roomId: room.id || null, items: [] });
        map.get(key)!.items.push(it);
      }
    }
    return [...map.values()].sort((a, b) => {
      if (a.roomId === null) return 1;
      if (b.roomId === null) return -1;
      return a.name.localeCompare(b.name);
    });
  }, [filtered]);

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
      onUpdate(item);
      setFlaggingId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusyId(null);
    }
  }

  async function bulkApprove(roomId: string | null) {
    setBulkBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/portal/${token}/bulk-approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room_id: roomId }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error ?? "Could not approve this room.");
      }
      const { items: updated } = await res.json();
      onUpdate(updated);
      setBulkConfirmKey(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not approve this room.");
    } finally {
      setBulkBusy(false);
    }
  }

  if (filtered.length === 0) {
    return (
      <div className="border border-dashed border-[#c9c2b4] p-8 text-center">
        <p className="text-body text-charcoal/60">
          {filter === "flagged" ? "Nothing flagged right now." : "Nothing waiting on you right now — nice work."}
        </p>
      </div>
    );
  }

  return (
    <div>
      {needsDecision.length > 0 && (
        <div className="mb-4 flex justify-end">
          <button
            type="button"
            onClick={() => setStepperOpen(true)}
            className="label-caps !text-sand hover:!text-nearblack"
          >
            Review one by one
          </button>
        </div>
      )}

      {error && (
        <p className="mb-4 border border-red-700/40 bg-red-50 px-3 py-2 text-body text-red-700">{error}</p>
      )}

      <div className="space-y-8">
        {groups.map((group) => {
          const groupKey = group.roomId ?? "unassigned";
          const approvableCount = group.items.filter((i) => !i.client_approved && !i.client_flagged).length;
          return (
            <section key={groupKey}>
              <div className="mb-3 flex items-center justify-between border-b border-nearblack bg-cream px-1 pb-2 pt-3">
                <h3 className="label-caps">{group.name}</h3>
                {approvableCount > 0 && (
                  <button
                    type="button"
                    onClick={() => setBulkConfirmKey(groupKey)}
                    className="label-caps !text-sand hover:!text-nearblack"
                  >
                    Approve all {approvableCount} in this room
                  </button>
                )}
              </div>

              {bulkConfirmKey === groupKey && (
                <div className="mb-3 border border-sand bg-offwhite p-3">
                  <p className="text-body text-charcoal/80">
                    Approve all {approvableCount} remaining item{approvableCount === 1 ? "" : "s"} in {group.name}? Flagged items are never
                    included.
                  </p>
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      disabled={bulkBusy}
                      onClick={() => bulkApprove(group.roomId)}
                      className="bg-nearblack px-4 py-2 text-subhead text-white hover:bg-charcoal disabled:opacity-60"
                    >
                      {bulkBusy ? "Approving…" : "Confirm approve all"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setBulkConfirmKey(null)}
                      className="px-3 py-2 text-subhead text-charcoal/60 hover:text-nearblack"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              <div className="space-y-2">
                {group.items.map((item) => {
                  const expanded = expandedId === item.id;
                  const overdue = isOverdue(item.decision_needed_by);
                  const justApproved = item.client_approved && justApprovedIds.has(item.id);

                  if (justApproved) {
                    return (
                      <article key={item.id} className="border border-sand bg-offwhite p-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-3">
                            {item.selected_image_url ? (
                              <div className="relative h-10 w-10 shrink-0 overflow-hidden bg-cream">
                                <Image
                                  src={renditionUrl(item.selected_image_url, { width: RENDITION_SIZES.thumb }) ?? item.selected_image_url}
                                  alt=""
                                  fill
                                  sizes="40px"
                                  className="object-cover"
                                />
                              </div>
                            ) : (
                              <div className="h-10 w-10 shrink-0 bg-cream" />
                            )}
                            <div>
                              <span className="label-caps mr-2">{item.item_code}</span>
                              <span className="text-body text-nearblack">{item.name}</span>
                              <p className="mt-0.5 text-caption !text-sand">Approved — moved to Your selections</p>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => onDismissApprovedNote(item.id)}
                            className="shrink-0 text-caption text-charcoal/40 hover:text-nearblack"
                          >
                            Dismiss
                          </button>
                        </div>
                      </article>
                    );
                  }

                  return (
                    <article
                      key={item.id}
                      className={clsx(
                        "border",
                        item.client_flagged ? "border-red-700/40 bg-red-50/40" : "border-[#dcd6cc] bg-nearwhite"
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => setExpandedId(expanded ? null : item.id)}
                        className="flex w-full items-center gap-3 p-3 text-left"
                      >
                        {item.selected_image_url ? (
                          <div className="relative h-12 w-12 shrink-0 overflow-hidden bg-cream">
                            <Image
                              src={renditionUrl(item.selected_image_url, { width: RENDITION_SIZES.thumb }) ?? item.selected_image_url}
                              alt=""
                              fill
                              sizes="48px"
                              className="object-cover"
                            />
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
                                  className="bg-nearblack px-4 py-2 text-subhead text-white transition-colors hover:bg-charcoal disabled:opacity-60"
                                >
                                  Approve
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
          onUpdate={(item) => onUpdate(item)}
          onClose={() => setStepperOpen(false)}
        />
      )}
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
        <button type="button" onClick={onCancel} className="px-4 py-2 text-subhead text-charcoal/60 hover:text-nearblack">
          Cancel
        </button>
      </div>
    </div>
  );
}
