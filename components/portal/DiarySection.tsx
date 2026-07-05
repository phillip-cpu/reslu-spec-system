import Image from "next/image";
import type { PortalUpdate } from "@/app/portal/types";
import { PortalSection } from "@/components/portal/PortalSection";
import { SimpleMarkdown } from "@/lib/simple-markdown";

/**
 * Diary — magazine-style journal entries (BUILD-SPEC.md §"Phase 11 —
 * Diary": "Client sees magazine-style entry (serif headline, photo,
 * short story)." + §"portal v2 restyle": "Diary (renamed from
 * Updates): magazine entry style — serif headline, 1-2 photos (from
 * portal_update_photos join, signed URLs), story text.")
 *
 * Renamed section (was "Updates" in Week 8B) — same id-stability
 * concern as everywhere else in this file: the anchor id stays
 * "diary" going forward (PortalNav is updated to match), and `updates`
 * passed in is already published-only + newest-first (server query
 * filters status/published_at, orders desc) exactly like the old feed.
 */
export function DiarySection({ updates }: { updates: PortalUpdate[] }) {
  if (updates.length === 0) {
    return (
      <PortalSection id="diary" title="Diary">
        <p className="text-body text-charcoal/50">No diary entries have been posted yet.</p>
      </PortalSection>
    );
  }

  return (
    <PortalSection id="diary" title="Diary">
      <div className="space-y-12">
        {updates.map((u) => (
          <article key={u.id} className="border-b border-[#e5e0d6] pb-10 last:border-b-0">
            <p className="label-caps mb-2 !text-sand">
              {new Date(u.published_at).toLocaleDateString("en-AU", {
                day: "numeric",
                month: "long",
                year: "numeric",
              })}
            </p>

            {u.photos.length > 0 && (
              <div className={u.photos.length === 1 ? "mb-4" : "mb-4 grid grid-cols-2 gap-2"}>
                {u.photos.slice(0, 2).map((p) => (
                  <div key={p.id} className="relative aspect-[4/3] overflow-hidden bg-cream">
                    <Image src={p.url} alt={p.caption ?? ""} fill sizes="(max-width: 640px) 100vw, 500px" className="object-cover" />
                  </div>
                ))}
              </div>
            )}

            <h3 className="font-display text-section text-nearblack">{u.title}</h3>
            <div className="mt-3">
              <SimpleMarkdown text={u.body_richtext} />
            </div>
          </article>
        ))}
      </div>
    </PortalSection>
  );
}
