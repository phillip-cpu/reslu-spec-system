"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { BookingProgressPill } from "@/components/trade-requests/BookingProgress";
import type {
  ProjectTradeBookingResponse,
  ProjectTradeBookingSummary,
} from "@/types/round-grouped-trade-booking";

function activityTime(row: ProjectTradeBookingSummary): string {
  const value =
    row.request.responded_at ??
    row.request.viewed_at ??
    row.email?.delivered_at ??
    row.email?.sent_at ??
    row.email?.scheduled_for ??
    row.request.created_at;
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Adelaide",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

/** A permanent project-level home for trade-booking state. */
export function TradeBookingStatusPanel({
  projectId,
  refreshKey,
}: {
  projectId: string;
  refreshKey: number;
}) {
  const [rows, setRows] = useState<ProjectTradeBookingSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch(`/api/projects/${projectId}/trade-requests`, { cache: "no-store" });
        if (!response.ok) return;
        const body = (await response.json()) as ProjectTradeBookingResponse;
        if (!cancelled) setRows(body.requests ?? []);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    const interval = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [projectId, refreshKey]);

  if (loading || rows.length === 0) return null;

  const activeCount = rows.filter((row) => row.counts.outstanding > 0).length;
  const visibleRows = expanded ? rows : rows.slice(0, 4);

  return (
    <section className="border border-[#dcd6cc] bg-offwhite" aria-label="Trade booking status">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#dcd6cc] px-4 py-3">
        <div>
          <p className="label-caps">Trade bookings</p>
          <p className="mt-1 text-caption text-charcoal/50">
            {activeCount > 0
              ? `${activeCount} awaiting a complete trade response`
              : "All recent booking requests answered"}
          </p>
        </div>
        {rows.length > 4 && (
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="text-caption text-charcoal/60 underline hover:text-nearblack"
          >
            {expanded ? "Show less" : `Show all ${rows.length}`}
          </button>
        )}
      </div>
      <div className="divide-y divide-[#dcd6cc]">
        {visibleRows.map((row) => (
          <div key={row.request.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <p className="truncate text-body text-nearblack">{row.contact?.company ?? "Trade"}</p>
              <p className="mt-0.5 text-caption text-charcoal/50">
                {row.counts.total} line{row.counts.total === 1 ? "" : "s"} · {activityTime(row)}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <BookingProgressPill progress={row.progress} />
              <Link
                href={`/trade-requests/${row.request.id}`}
                className="border border-nearblack px-3 py-1.5 text-caption text-nearblack hover:bg-nearblack hover:text-white"
              >
                View status
              </Link>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
