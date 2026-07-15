"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import type { AriaActivityResponse } from "@/types/aria-activity";

function when(value: string): string {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Adelaide",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export function AriaActivityPanel({ initialData }: { initialData: AriaActivityResponse }) {
  const [data, setData] = useState(initialData);
  const [refreshing, setRefreshing] = useState(false);

  async function refresh() {
    setRefreshing(true);
    try {
      const response = await fetch("/api/aria-activity", { cache: "no-store" });
      if (response.ok) setData(await response.json());
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    const interval = window.setInterval(refresh, 60_000);
    return () => window.clearInterval(interval);
  }, []);

  const exceptions = data.items.filter((item) => item.is_exception);
  const recent = data.items.slice(0, 12);

  return (
    <details open={exceptions.length > 0} className="mb-8 border border-[#dcd6cc] bg-offwhite">
      <summary className="cursor-pointer list-none px-5 py-4 marker:hidden">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="label-caps !text-charcoal/50">Aria</p>
            <h2 className="font-serif text-2xl text-nearblack">Activity & exceptions</h2>
          </div>
          <div className="flex flex-wrap gap-2 text-caption">
            <span className="border border-[#c9c2b4] px-2 py-1">{data.summary.waiting} waiting</span>
            <span className="border border-[#c9c2b4] px-2 py-1">{data.summary.working} working</span>
            <span className={clsx("border px-2 py-1", data.summary.failed_7d ? "border-red-700/40 bg-red-50 text-red-700" : "border-[#c9c2b4]")}>{data.summary.failed_7d} failed</span>
            <span className={clsx("border px-2 py-1", data.summary.approvals ? "border-sand bg-cream" : "border-[#c9c2b4]")}>{data.summary.approvals} approvals</span>
          </div>
        </div>
      </summary>
      <div className="border-t border-[#dcd6cc] px-5 py-4">
        <div className="mb-3 flex items-center justify-between">
          <p className="text-caption text-charcoal/50">Recent queue work and any failed or abandoned claims.</p>
          <button type="button" onClick={refresh} disabled={refreshing} className="text-caption text-charcoal/55 underline disabled:opacity-50">{refreshing ? "Refreshing…" : "Refresh"}</button>
        </div>
        {recent.length === 0 ? (
          <p className="text-body text-charcoal/45">No Aria activity recorded yet.</p>
        ) : (
          <div className="divide-y divide-[#dcd6cc]">
            {recent.map((item) => (
              <div key={item.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-body text-nearblack">{item.title}</p>
                  {item.detail && <p className="mt-0.5 truncate text-caption text-charcoal/50" title={item.detail}>{item.detail}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className={clsx(
                    "border px-2 py-1 text-caption",
                    item.is_exception ? "border-red-700/40 bg-red-50 text-red-700" :
                      item.status === "done" ? "border-[#4c6b4f]/40 bg-[#DCE7DD] text-[#2E4531]" :
                      item.status === "picked_up" ? "border-sand bg-cream text-nearblack" :
                      "border-[#c9c2b4] text-charcoal"
                  )}>{item.is_exception && item.status === "picked_up" ? "Claim expired" : item.status.replace("_", " ")}</span>
                  <span className="text-caption text-charcoal/40">{when(item.resolved_at ?? item.picked_up_at ?? item.created_at)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

