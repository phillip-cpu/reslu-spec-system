"use client";

import { useMemo, useState } from "react";
import clsx from "clsx";
import Image from "next/image";
import Link from "next/link";
import type { PortalItemWithFiles } from "@/app/portal/types";
import { PortalSection } from "@/components/portal/PortalSection";
import { SelectionsStepper } from "@/components/portal/SelectionsStepper";
import { renditionUrl, RENDITION_SIZES } from "@/lib/image-url";

const UNASSIGNED = "Other";

const FILE_KIND_LABELS: Record<string, string> = {
  spec_sheet: "Spec sheet",
  install_manual: "Install manual",
  warranty: "Warranty",
  other: "Document",
};

type FilterKey = "awaiting" | "flagged";

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "awaiting", label: "Awaiting" },
  { key: "flagged", label: "Flagged" },
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
 * trade confirmations" point 4, "must scale to 200+ items"), refined by
 * §"Portal selections separation" (fix round B):
 *
 *   "Main portal page shows ONLY 'Needs your decision' (+ flagged) in
 *   the Selections section. Approved items move to a SEPARATE portal
 *   page: /portal/[token]/selections ... reached via a compact link
 *   card on the main page ('Your selections · 132 approved →') and the
 *   portal nav. Approving an item removes it from the main list
 *   immediately (optimistic) with a subtle 'moved to Your selections'
 *   note."
 *
 * This SUPERSEDES the original Phase 11B "Approved" filter chip and
 * "132 of 204 approved" progress framing — approved items are no
 * longer rendered in this section's groups at all (they live on the
 * separate gallery page instead), so the filter chips are now just
 * Awaiting/Flagged, and the progress header becomes a plain "N still
 * to review" count with a link to the approved gallery rather than a
 * fraction bar (a bar implying "approved out of total" made less sense
 * once approved items are no longer shown alongside it).
 *
 * Still: compact rows (thumb, code, name, tap to expand details/
 * images) grouped by room with "Approve all N in this room" bulk
 * action (confirm dialog; writes individual approval_events per item),
 * and a "Review one by one" mode — full-screen single-item stepper.
 * Approving via bulk never includes flagged items.
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
  // Item ids that were just approved this session — kept around only
  // long enough to render the "moved to Your selections" note in place
  // of the row (rather than removed instantly, which would be jarring)
  // before disappearing on the next render pass/reload. Fix round B
  // §"Portal selections separation": "Approving an item removes it
  // from the main list immediately (optimistic) with a subtle 'moved
  // to Your selections' note."
  const [justApprovedIds, setJustApprovedIds] = useState<Set<string>>(new Set());

  const approvedCount = items.filter((i) => i.client_approved).length;
  const flaggedCount = items.filter((i) => i.client_flagged).length;
  // "Needs your decision" — the main page's whole population per the
  // fix round: never-decided items, PLUS flagged ones (flags are a
  // form of "still needs attention", not a finished state). Approved
  // items (unless still lingering in justApprovedIds for their
  // one-render "moved" note) are excluded entirely.
  const needsDecision = items.filter((i) => !i.client_approved || justApprovedIds.has(i.id));
  const total = needsDecision.length;

  const filtered = useMemo(() => {
    if (!filter) return needsDecision;
    if (filter === "awaiting") return needsDecision.filter((i) => !i.client_approved && !i.client_flagged);
    return needsDecision.filter((i) => i.client_flagged);
  }, [needsDecision, filter]);

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
    // Any item that just became approved gets a brief "moved to Your
    // selections" note instead of instantly vanishing from the list.
    const newlyApproved = list.filter((u) => u.client_approved).map((u) => u.id);
    if (newlyApproved.length > 0) {
      setJustApprovedIds((cur) => new Set([...cur, ...newlyApproved]));
    }
  }

  function dismissApprovedNote(id: string) {
    setJustApprovedIds((cur) => {
      const next = new Set(cur);
      next.delete(id);
      return next;
    });
    setExpandedId((cur) => (cur === id ? null : cur));
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
      {/* Compact link card to the separate "Your selections" gallery —
          BUILD-SPEC.md §"Portal selections separation": "a compact link
          card on the main page ('Your selections · 132 approved →')". */}
      {approvedCount > 0 && (
        <Link
          href={`/portal/${token}/selections`}
          className="mb-4 flex items-center justify-between border border-sand bg-offwhite px-4 py-3 transition-colors hover:bg-cream"
        >
          <span className="text-body text-nearblack">
            Your selections · {approvedCount} approved
          </span>
          <span className="label-caps !text-sand">View →</span>
        </Link>
      )}

      {/* Progress header */}
      <div className="mb-4">
        <div className="flex items-baseline justify-between">
          <p className="text-subhead text-nearblack">
            {total} item{total === 1 ? "" : "s"} need{total === 1 ? "s" : ""} your decision
          </p>
          {total > 0 && (
            <button
              type="button"
              onClick={() => setStepperOpen(true)}
              className="label-caps !text-sand hover:!text-nearblack"
            >
              Review one by one
            </button>
          )}
        </div>
      </div>

      {total > 0 && (
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
            const count = f.key === "awaiting" ? total - flaggedCount : flaggedCount;
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
      )}

      {error && (
        <p className="mb-4 border border-red-700/40 bg-red-50 px-3 py-2 text-body text-red-700">{error}</p>
      )}

      {total === 0 && (
        <div className="border border-dashed border-[#c9c2b4] p-8 text-center">
          <p className="text-body text-charcoal/60">
            Nothing waiting on you right now — nice work.{" "}
            <Link href={`/portal/${token}/selections`} className="underline decoration-sand underline-offset-2 hover:decoration-nearblack">
              See everything you&apos;ve approved
            </Link>
            .
          </p>
        </div>
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
                  const justApproved = item.client_approved && justApprovedIds.has(item.id);

                  // Fix round B: an item that was just approved this
                  // session renders a subtle "moved to Your selections"
                  // note in place of its normal compact row/expand
                  // interaction — it's about to disappear from this
                  // list on the next reload, this is its one beat of
                  // visible confirmation first.
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
                              <p className="mt-0.5 text-caption !text-sand">
                                Approved — moved to{" "}
                                <Link href={`/portal/${token}/selections`} className="underline decoration-sand underline-offset-2 hover:decoration-nearblack">
                                  Your selections
                                </Link>
                              </p>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => dismissApprovedNote(item.id)}
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
                        // Reaching this branch means client_approved is
                        // false (the justApproved early-return above
                        // handles the only case it could be true) — so
                        // only the flagged/plain distinction applies.
                        item.client_flagged ? "border-red-700/40 bg-red-50/40" : "border-[#dcd6cc] bg-nearwhite"
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
                            {/* Phase 14A perf: compact-row thumb at scale
                                (this list must handle 200+ items —
                                BUILD-SPEC.md) — rewritten to a small
                                Supabase image-transform rendition rather
                                than the full-size original. */}
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
                                {/* This branch of the article only ever
                                    renders for NOT-yet-approved items —
                                    a just-approved item takes the
                                    dedicated "moved to Your selections"
                                    branch above instead — so this
                                    button is always in its plain
                                    "Approve" state here. */}
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
