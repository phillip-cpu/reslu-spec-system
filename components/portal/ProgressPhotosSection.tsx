"use client";

import { useState } from "react";
import Image from "next/image";
import type { PortalProgressPhoto } from "@/app/portal/types";
import { PortalSection } from "@/components/portal/PortalSection";

/**
 * Progress photos section (BUILD-SPEC.md "Week 8 — Client portal
 * expansion": "Progress photos (grid, newest first, signed URLs,
 * lightbox = simple full-width toggle)"). initialPhotos is already
 * newest-first (server query orders created_at desc).
 */
export function ProgressPhotosSection({ photos }: { photos: PortalProgressPhoto[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const open = photos.find((p) => p.id === openId) ?? null;

  if (photos.length === 0) {
    return (
      <PortalSection id="photos" title="Progress photos">
        <p className="text-body text-charcoal/50">No progress photos have been shared yet.</p>
      </PortalSection>
    );
  }

  return (
    <PortalSection id="photos" title="Progress photos">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {photos.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => setOpenId(p.id)}
            className="relative aspect-square overflow-hidden bg-cream"
          >
            {/* Phase 14A perf: grid tile uses the smaller thumb_url
                rendition when present (see lib/image-url.ts); full-size
                `url` is reserved for the lightbox below. */}
            <Image src={p.thumb_url ?? p.url} alt={p.caption ?? ""} fill sizes="220px" className="object-cover" />
          </button>
        ))}
      </div>

      {open && (
        <div
          className="fixed inset-0 z-20 flex flex-col bg-nearblack/95 p-4"
          onClick={() => setOpenId(null)}
        >
          <div className="relative mx-auto w-full max-w-2xl flex-1" onClick={(e) => e.stopPropagation()}>
            <div className="relative h-full w-full">
              <Image src={open.url} alt={open.caption ?? ""} fill sizes="100vw" className="object-contain" />
            </div>
          </div>
          <div className="mx-auto mt-3 w-full max-w-2xl text-center">
            {open.caption && <p className="text-body text-white">{open.caption}</p>}
            <p className="mt-1 text-caption text-white/50">
              {new Date(open.taken_at ?? open.created_at).toLocaleDateString("en-AU", { timeZone: "Australia/Adelaide" })}
            </p>
            <button
              type="button"
              onClick={() => setOpenId(null)}
              className="mt-4 border border-white/40 px-4 py-2 text-subhead text-white hover:bg-white/10"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </PortalSection>
  );
}
