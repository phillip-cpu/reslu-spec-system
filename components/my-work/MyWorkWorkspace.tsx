"use client";

import { useEffect, useState } from "react";
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
};

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
}: {
  label: string;
  emptyLabel: string;
  items: MyWorkItem[];
  highlightOverdue: boolean;
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
            <ItemRow key={`${item.kind}-${item.id}`} item={item} overdue={highlightOverdue} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ItemRow({ item, overdue }: { item: MyWorkItem; overdue: boolean }) {
  return (
    <li>
      <a
        href={item.href}
        className={clsx(
          "flex items-center justify-between gap-3 border bg-offwhite px-4 py-3 transition-colors hover:border-nearblack",
          overdue ? "border-red-700/30" : "border-[#dcd6cc]"
        )}
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {item.project && (
              <span className="label-caps shrink-0 border border-[#c9c2b4] px-1.5 py-0.5 !text-charcoal/50">
                {item.project.name}
                {item.project.alias && <span className="text-charcoal/35"> · {item.project.alias}</span>}
              </span>
            )}
            {/* project is null for both leads (pre-project) and Phase 13
                Office tasks (global board, no project at all) — the
                fallback chip distinguishes the two rather than always
                saying "Lead". */}
            {!item.project && (
              <span className="label-caps shrink-0 border border-[#c9c2b4] px-1.5 py-0.5 !text-charcoal/50">
                {item.kind === "office_task" ? "Office" : "Lead"}
              </span>
            )}
            <span className="label-caps shrink-0 !text-sand">{KIND_LABEL[item.kind]}</span>
          </div>
          <p className="mt-1 truncate text-body text-nearblack">{item.title}</p>
          {item.meta && <p className="mt-0.5 text-caption text-charcoal/50">{item.meta}</p>}
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
