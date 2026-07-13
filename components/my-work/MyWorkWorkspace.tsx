"use client";

import { useEffect, useState, type MouseEvent } from "react";
import clsx from "clsx";
import type { MyWorkGroups, MyWorkItem, MyWorkResponse } from "@/types/phase-12a-b";
import { NotesPanel } from "@/components/my-work/NotesPanel";
import { DailyBrief } from "@/components/my-work/DailyBrief";
import { formatTime12h } from "@/lib/time-format";

const KIND_LABEL: Record<MyWorkItem["kind"], string> = {
  board_task: "Board task",
  lead_follow_up: "Lead follow-up",
  diary_draft: "Diary draft",
  trade_proposal: "Trade proposal",
  decision_overdue: "Client decision",
  // Phase 13 — Office board task assigned to me (GET /api/my-work
  // source #6). Additive entry, same shape as every other kind here.
  office_task: "Office",
  // Fix Round A — trade insurance expiring/expired (GET /api/my-work
  // source #7). Additive entry, same shape as every other kind here.
  insurance_expiring: "Insurance",
  // Phase 12b — Design Framework task assigned to me (GET /api/my-work
  // source #8). Additive entry, same shape as every other kind here —
  // this task's brief calls for a "'Design' context chip", already
  // carried on item.meta (always "Design" for this kind, see that
  // route's own doc comment) and rendered by the existing `item.meta`
  // line below; this KIND_LABEL entry is the pill next to the title.
  design_task: "Design",
  // Bug fix, 8 July 2026: order-by engine (GET /api/my-work source #9)
  // added "ordering_due" to MyWorkItemKind (types/phase-12a-b.ts) but
  // this Record was never updated to match — a genuine TS2741 build
  // error (Record<MyWorkItemKind, string> requires every kind to have
  // an entry), not a stale-cache artifact. This file is outside that
  // round's own designated file list, which is exactly why it was
  // missed.
  ordering_due: "Order by",
  // CPD tracker round — pro-rata pace nudge (GET /api/my-work source
  // #10). Additive entry, same shape as every other kind here.
  cpd_nudge: "CPD",
  // Grouped trade booking round (r20) — 3-day no-response follow-up
  // (GET /api/my-work source #11). Additive entry, same shape as every
  // other kind here.
  trade_booking_followup: "Trade follow-up",
  // Fee proposal phase round (r23) — 5-day not-accepted follow-up (GET
  // /api/my-work source #12). Additive entry, same shape as every other
  // kind here — missing this entry is a real TS2741 build error
  // (Record<MyWorkItemKind, string> requires every kind to have one),
  // per the "ordering_due" bug-fix precedent noted above.
  proposal_followup: "Proposal follow-up",
  // QA fix round (r27) item 12 — "wire the dead attention aggregator"
  // (GET /api/my-work source #13, types/phase-12a-b.ts's own
  // MyWorkItemKind comment has the full story). Additive entry, same
  // shape as every other kind here — omitting it is the exact same
  // TS2741 build error the "ordering_due"/"proposal_followup" comments
  // above both already flag for this Record.
  missing_lead_time: "Lead time",
};

/** project is null for leads (pre-project), Office tasks (global board), AND the CPD nudge (no project concept at all) — this small lookup picks the right fallback chip label for each, replacing what used to be a two-way ternary before cpd_nudge existed. */
function projectlessChipLabel(kind: MyWorkItem["kind"]): string {
  if (kind === "office_task") return "Office";
  if (kind === "cpd_nudge") return "CPD";
  return "Lead";
}

/**
 * Bug fix, 8 July 2026: was `toLocaleDateString("en-AU", { day:
 * "numeric", month: "short" })` — the same genuine cross-engine Intl/
 * ICU hydration mismatch already fixed in components/board/DateCell.tsx
 * and ProjectBoard.tsx (Node's en-AU "short" month renders "July";
 * Safari/WebKit's renders "Jul" — same date, same locale, same
 * options, different server-vs-client text). A manual, hardcoded
 * month-abbreviation array has zero locale/ICU dependency, so server
 * and client can never disagree.
 */
const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatDueShort(due: string): string {
  const d = new Date(due.length <= 10 ? `${due}T00:00:00` : due);
  return `${d.getDate()} ${SHORT_MONTHS[d.getMonth()]}`;
}

/**
 * Site capture + mobile QoL round (r21), BUILD-SPEC.md item 6: "My
 * Work checkboxes — office/task items on My Work get an inline
 * checkbox to mark complete (writes the same completion the source
 * screen would)." Only kinds with a REAL completion semantic are
 * wired: office_task (PATCH /api/office/tasks/[id] { complete: true })
 * and design_task (PATCH /api/design-tasks/[id] { complete: true }) —
 * both already carry a `completed_at` column and an existing
 * `complete` boolean-intent PATCH action their own source screens
 * (the Office board, the Design tab) already use, so ticking the box
 * here writes the EXACT SAME completion those screens would, never a
 * parallel/invented state (per this task's brief). Every other kind
 * is deliberately left alone — board_task has no single-column
 * "complete" concept (completion there is a column/status move, not a
 * boolean), and lead_follow_up/diary_draft/trade_proposal/
 * decision_overdue/insurance_expiring/ordering_due/cpd_nudge/
 * trade_booking_followup are all informational flags/rollups/prompts
 * with no underlying "done" write at all.
 */
const COMPLETABLE_ENDPOINT: Partial<Record<MyWorkItem["kind"], (id: string) => string>> = {
  office_task: (id) => `/api/office/tasks/${id}`,
  design_task: (id) => `/api/design-tasks/${id}`,
};

const SECTIONS: { key: keyof MyWorkGroups; label: string; emptyLabel: string }[] = [
  { key: "overdue", label: "Overdue", emptyLabel: "Nothing overdue." },
  { key: "today", label: "Today", emptyLabel: "Nothing due today." },
  { key: "this_week", label: "This week", emptyLabel: "Nothing due this week." },
  { key: "no_date", label: "No date", emptyLabel: "Nothing undated." },
];

/**
 * My Work aggregator UI (BUILD-SPEC.md §"Phase 12a — My Work"): four
 * date-bucketed groupings (Overdue / Today / This week / No date) fed
 * by GET /api/my-work, plus a personal notes panel (user_notes CRUD).
 * Two-column layout on wide screens (feed left, notes right) collapsing
 * to a single column on narrow screens — matches this codebase's other
 * "main content + side panel" pages (e.g. the leads dashboard summary
 * alongside its kanban).
 */
export function MyWorkWorkspace() {
  const [data, setData] = useState<MyWorkResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/my-work")
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json()).error ?? "Could not load My Work.");
        return res.json();
      })
      .then((body) => {
        if (!cancelled) setData(body);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load My Work.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * BUILD-SPEC.md item 6 — ticking the checkbox writes the SAME
   * completion PATCH the item's own source screen (Office board /
   * Design tab) uses, then optimistically removes it from every
   * bucket client-side (mirrors those source screens' own "completed
   * items disappear from the active list" behaviour, and matches GET
   * /api/my-work's own server-side filter — a completed office_task/
   * design_task is `is("completed_at", null)`-excluded on the very
   * next load anyway, this just avoids waiting for a refetch).
   */
  async function completeItem(item: MyWorkItem) {
    const endpoint = COMPLETABLE_ENDPOINT[item.kind];
    if (!endpoint) return;
    const res = await fetch(endpoint(item.id), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ complete: true }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? "Could not mark complete.");
    }
    setData((prev) => {
      if (!prev) return prev;
      const nextGroups = { ...prev.groups };
      for (const key of Object.keys(nextGroups) as (keyof MyWorkGroups)[]) {
        nextGroups[key] = nextGroups[key].filter((i) => !(i.kind === item.kind && i.id === item.id));
      }
      return { ...prev, groups: nextGroups };
    });
  }

  return (
    <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_320px]">
      <div className="space-y-8">
        {/* Daily Brief (migration 041, Phillip 8 July 2026) — "My Work
            page = Daily Brief panel FIRST, then the My Work groups" —
            mounted above every SECTIONS group below, own independent
            fetch (GET /api/brief), never blocks this page's own
            GET /api/my-work load. */}
        <DailyBrief />

        {error && (
          <p className="border border-red-700/40 bg-red-50 px-4 py-2 text-body text-red-700">{error}</p>
        )}

        {!data && !error && <p className="text-body text-charcoal/50">Loading…</p>}

        {data &&
          SECTIONS.map((section) => (
            <Section
              key={section.key}
              label={section.label}
              emptyLabel={section.emptyLabel}
              items={data.groups[section.key]}
              highlightOverdue={section.key === "overdue"}
              onComplete={completeItem}
            />
          ))}
      </div>

      <NotesPanel />
    </div>
  );
}

function Section({
  label,
  emptyLabel,
  items,
  highlightOverdue,
  onComplete,
}: {
  label: string;
  emptyLabel: string;
  items: MyWorkItem[];
  highlightOverdue: boolean;
  onComplete: (item: MyWorkItem) => Promise<void>;
}) {
  return (
    <section>
      <p className={clsx("label-caps mb-3", highlightOverdue && items.length > 0 ? "!text-red-700" : "!text-sand")}>
        {label} · {items.length}
      </p>
      {items.length === 0 ? (
        <p className="text-body text-charcoal/40">{emptyLabel}</p>
      ) : (
        <ul className="space-y-2">
          {items.map((item) => (
            <ItemRow key={`${item.kind}-${item.id}`} item={item} overdue={highlightOverdue} onComplete={onComplete} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ItemRow({
  item,
  overdue,
  onComplete,
}: {
  item: MyWorkItem;
  overdue: boolean;
  onComplete: (item: MyWorkItem) => Promise<void>;
}) {
  const completable = item.kind in COMPLETABLE_ENDPOINT;
  const [completing, setCompleting] = useState(false);
  const [completeError, setCompleteError] = useState<string | null>(null);

  async function handleComplete(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (completing) return;
    setCompleting(true);
    setCompleteError(null);
    try {
      await onComplete(item);
      // On success the item is removed from state by the parent — this
      // component unmounts, no further local state update needed.
    } catch (err) {
      setCompleting(false);
      setCompleteError(err instanceof Error ? err.message : "Could not mark complete.");
    }
  }

  return (
    <li>
      <a
        href={item.href}
        className={clsx(
          "flex items-center justify-between gap-3 border bg-offwhite px-4 py-3 transition-colors hover:border-nearblack",
          overdue ? "border-red-700/30" : "border-[#dcd6cc]"
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {completable && (
            <button
              type="button"
              aria-label="Mark complete"
              title="Mark complete"
              disabled={completing}
              onClick={handleComplete}
              className="flex h-5 w-5 shrink-0 items-center justify-center border border-[#c9c2b4] text-caption text-nearblack transition-colors hover:border-nearblack hover:bg-nearblack hover:text-white disabled:opacity-40"
            >
              {completing ? "…" : ""}
            </button>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              {item.project && (
                <span className="label-caps shrink-0 border border-[#c9c2b4] px-1.5 py-0.5 !text-charcoal/50">
                  {item.project.name}
                  {item.project.alias && <span className="text-charcoal/35"> · {item.project.alias}</span>}
                </span>
              )}
              {/* project is null for leads (pre-project), Phase 13 Office
                  tasks (global board), and the CPD nudge (no project
                  concept) — projectlessChipLabel() picks the right
                  fallback chip rather than always saying "Lead". */}
              {!item.project && (
                <span className="label-caps shrink-0 border border-[#c9c2b4] px-1.5 py-0.5 !text-charcoal/50">
                  {projectlessChipLabel(item.kind)}
                </span>
              )}
              <span className="label-caps shrink-0 !text-sand">{KIND_LABEL[item.kind]}</span>
            </div>
            <p className="mt-1 truncate text-body text-nearblack">{item.title}</p>
            {item.meta && <p className="mt-0.5 text-caption text-charcoal/50">{item.meta}</p>}
            {completeError && <p className="mt-0.5 text-caption text-red-700">{completeError}</p>}
          </div>
        </div>
        {item.due && (
          <span className={clsx("shrink-0 text-caption", overdue ? "text-red-700" : "text-charcoal/50")}>
            {formatDueShort(item.due)}
            {/* migration 041 ("Small pair" item 2) — "2:30pm" alongside the date, only ever set for board_task/office_task/design_task sources. */}
            {item.due_time ? ` ${formatTime12h(item.due_time)}` : ""}
          </span>
        )}
      </a>
    </li>
  );
}
