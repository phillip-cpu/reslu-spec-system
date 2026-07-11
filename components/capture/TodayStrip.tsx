"use client";

import Image from "next/image";
import type { SiteCaptureWithUrl } from "@/types/site-captures";
import { adelaideTimeLabel } from "@/lib/site-captures";

/**
 * BUILD-SPEC.md item 1a — "Every capture shows in a 'today' strip
 * below with timestamp (Australia/Adelaide)." Reverse-chronological
 * (the caller already appends new captures to the front of the array —
 * see CaptureWorkspace's onCaptured — and the initial GET is already
 * newest-first), already pre-filtered to today by the caller.
 */
export function TodayStrip({ captures, loading }: { captures: SiteCaptureWithUrl[]; loading: boolean }) {
  return (
    <div>
      <p className="label-caps mb-2 text-sand">Today</p>
      {loading && captures.length === 0 ? (
        <p className="text-body text-charcoal/40">Loading…</p>
      ) : captures.length === 0 ? (
        <p className="text-body text-charcoal/40">Nothing captured yet today.</p>
      ) : (
        <ul className="space-y-2">
          {captures.map((c) => (
            <li key={c.id} className="flex items-center gap-3 border border-[#dcd6cc] bg-offwhite px-3 py-2">
              {c.kind === "photo" && c.thumb_url ? (
                <div className="relative h-10 w-10 shrink-0 overflow-hidden bg-cream">
                  <Image src={c.thumb_url} alt="" fill sizes="40px" className="object-cover" />
                </div>
              ) : (
                <span className="flex h-10 w-10 shrink-0 items-center justify-center border border-[#c9c2b4] text-caption text-charcoal/60">
                  {c.kind === "audio" ? "audio" : "note"}
                </span>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-body text-nearblack">
                  {c.kind === "note" ? c.text_content : c.kind === "audio" ? "Voice note" : "Photo"}
                </p>
                <p className="text-caption text-charcoal/50">{adelaideTimeLabel(c.created_at)}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
