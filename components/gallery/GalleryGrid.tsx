"use client";

import { useMemo, useState } from "react";
import clsx from "clsx";
import Image from "next/image";
import type { SitePhoto } from "./GalleryUploader";

function dateGroupLabel(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

/**
 * Grid grouped by taken_at date (BUILD-SPEC.md "grid by date, captions
 * inline"), with a publish toggle per photo and multi-select for
 * "Add to diary draft" (BUILD-SPEC.md "multi-select → 'Add to diary
 * draft'"). Mobile-first: large tap targets, 2-up grid on narrow
 * screens growing to more columns on wider ones.
 */
export function GalleryGrid({
  photos,
  onCaptionChange,
  onPublishToggle,
  selectable,
  selectedIds,
  onToggleSelect,
}: {
  photos: SitePhoto[];
  onCaptionChange: (id: string, caption: string) => void;
  onPublishToggle: (id: string, next: boolean) => void;
  selectable: boolean;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftCaption, setDraftCaption] = useState("");

  const groups = useMemo(() => {
    const map = new Map<string, SitePhoto[]>();
    for (const p of photos) {
      const key = p.taken_at;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(p);
    }
    return [...map.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [photos]);

  if (photos.length === 0) {
    return (
      <div className="border border-dashed border-[#c9c2b4] p-10 text-center">
        <p className="text-body text-charcoal/60">No site photos yet. Take or upload the first one above.</p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {groups.map(([date, groupPhotos]) => (
        <section key={date}>
          <h2 className="label-caps mb-3 border-b border-nearblack pb-2">{dateGroupLabel(date)}</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
            {groupPhotos.map((photo) => {
              const selected = selectedIds.has(photo.id);
              return (
                <div
                  key={photo.id}
                  className={clsx(
                    "relative border bg-nearwhite",
                    selected ? "border-sand ring-2 ring-sand" : "border-[#dcd6cc]"
                  )}
                >
                  {selectable && (
                    <button
                      type="button"
                      onClick={() => onToggleSelect(photo.id)}
                      className={clsx(
                        "absolute left-2 top-2 z-10 flex h-6 w-6 items-center justify-center border text-caption",
                        selected ? "border-sand bg-sand text-white" : "border-white bg-nearblack/50 text-white"
                      )}
                      aria-label={selected ? "Deselect photo" : "Select photo"}
                    >
                      {selected ? "✓" : ""}
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => (selectable ? onToggleSelect(photo.id) : undefined)}
                    className="relative block aspect-square w-full overflow-hidden bg-cream"
                  >
                    {photo.url && (
                      <Image src={photo.url} alt={photo.caption ?? "Site photo"} fill sizes="200px" className="object-cover" />
                    )}
                  </button>

                  <div className="p-2">
                    {editingId === photo.id ? (
                      <div className="flex gap-1">
                        <input
                          autoFocus
                          value={draftCaption}
                          onChange={(e) => setDraftCaption(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              onCaptionChange(photo.id, draftCaption);
                              setEditingId(null);
                            }
                          }}
                          className="w-full border border-[#c9c2b4] bg-white px-2 py-1 text-caption focus:border-nearblack focus:outline-none"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            onCaptionChange(photo.id, draftCaption);
                            setEditingId(null);
                          }}
                          className="shrink-0 bg-nearblack px-2 text-caption text-white"
                        >
                          Save
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setEditingId(photo.id);
                          setDraftCaption(photo.caption ?? "");
                        }}
                        className="w-full truncate text-left text-caption text-charcoal/70 hover:text-nearblack"
                      >
                        {photo.caption || "Add caption…"}
                      </button>
                    )}

                    <div className="mt-1.5 flex items-center justify-between">
                      <button
                        type="button"
                        onClick={() => onPublishToggle(photo.id, !photo.published_to_portal)}
                        className={clsx(
                          "label-caps",
                          photo.published_to_portal ? "!text-sand" : "!text-charcoal/40"
                        )}
                      >
                        {photo.published_to_portal ? "Published" : "Not published"}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
