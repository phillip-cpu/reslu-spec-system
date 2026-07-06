import Image from "next/image";
import Link from "next/link";
import { renditionUrl, RENDITION_SIZES } from "@/lib/image-url";

const UNASSIGNED = "Other";

/** Minimal shape the gallery needs — deliberately NOT the full
 * PortalItemWithFiles (which carries description/supplier/pricing-
 * adjacent fields this read-only gallery never renders and this
 * page's query never even selects). */
export interface YourSelectionGalleryItem {
  id: string;
  item_code: string;
  name: string;
  location: string | null;
  selected_image_url: string | null;
}

/**
 * "Your selections" gallery — BUILD-SPEC.md §"Portal selections
 * separation" (fix round B): "Approved items move to a SEPARATE portal
 * page: /portal/[token]/selections — 'Your selections' gallery grouped
 * by room (thumbnails, code, name)."
 *
 * Server-rendered (no client state needed — this page is read-only,
 * unlike the main Selections section which needs approve/flag
 * interactivity). Never shows pricing (item_code/name/thumbnail only,
 * same PORTAL_FIELDS-derived whitelist as the parent page's Selections
 * section) — zero pricing, per BUILD-SPEC.md's non-negotiable portal
 * rule.
 */
export function YourSelectionsGallery({
  token,
  items,
}: {
  token: string;
  items: YourSelectionGalleryItem[];
}) {
  const groups = new Map<string, YourSelectionGalleryItem[]>();
  for (const item of items) {
    const key = item.location?.trim() || UNASSIGNED;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(item);
  }
  const sortedGroups = [...groups.entries()].sort((a, b) => {
    if (a[0] === UNASSIGNED) return 1;
    if (b[0] === UNASSIGNED) return -1;
    return a[0].localeCompare(b[0]);
  });

  if (items.length === 0) {
    return (
      <div className="border border-dashed border-[#c9c2b4] p-12 text-center">
        <p className="text-body text-charcoal/60">
          Nothing approved yet.{" "}
          <Link href={`/portal/${token}`} className="underline decoration-sand underline-offset-2 hover:decoration-nearblack">
            Head back to your selections
          </Link>{" "}
          to review what&apos;s awaiting a decision.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {sortedGroups.map(([location, groupItems]) => (
        <section key={location}>
          <div className="mb-3 border-b border-nearblack pb-2">
            <h3 className="label-caps">
              {location} · {groupItems.length}
            </h3>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
            {groupItems.map((item) => (
              <div key={item.id} className="border border-[#dcd6cc] bg-nearwhite">
                <div className="relative aspect-square w-full overflow-hidden bg-cream">
                  {item.selected_image_url ? (
                    <Image
                      src={renditionUrl(item.selected_image_url, { width: RENDITION_SIZES.card }) ?? item.selected_image_url}
                      alt=""
                      fill
                      sizes="(min-width: 768px) 25vw, (min-width: 640px) 33vw, 50vw"
                      className="object-cover"
                    />
                  ) : (
                    <span className="flex h-full w-full items-center justify-center text-caption text-charcoal/25">
                      No image
                    </span>
                  )}
                </div>
                <div className="p-2.5">
                  <p className="label-caps !text-charcoal/50">{item.item_code}</p>
                  <p className="mt-0.5 truncate text-body text-nearblack">{item.name}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
