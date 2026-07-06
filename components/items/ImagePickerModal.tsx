"use client";

import { useEffect, useRef } from "react";
import Image from "next/image";

/**
 * Image options modal picker — BUILD-SPEC.md "Image options → modal
 * picker": the expanded item row shows only the selected image + a
 * "Choose image · N found" button; clicking it opens this modal with a
 * larger grid of every candidate (items.image_options), an Upload
 * button, and the current selection highlighted. Extracted out of
 * ItemAssets.tsx's inline 4-col grid (which is now collapsed to just
 * the selected thumbnail + this trigger button) so the full candidate
 * set gets real screen space instead of a cramped sidebar strip.
 *
 * Faux-window overlay, no new dependency: a `fixed inset-0` backdrop +
 * a centered `relative` panel, closes on Escape or backdrop click —
 * same interaction contract as components/gantt/VisitBottomSheet.tsx's
 * bottom sheet and LeadDetailPanel's slide-over (stopPropagation on the
 * inner panel so a click inside doesn't bubble to the backdrop).
 *
 * LAYOUT NOTE (verified — no position:fixed-inside-scroll-container
 * pitfall here): this modal is always mounted as a sibling of
 * ItemAssets' own returned JSX, itself rendered inside SpecRegister's
 * expanded item row. `position: fixed` is computed against the nearest
 * *transformed* ancestor (CSS containing-block rules) or the viewport
 * if none exists; grep across this codebase's item/register components
 * turned up no `transform`/`perspective`/`filter`/`will-change`
 * ancestor between this modal and <body> in that render path (the
 * expanded row uses ordinary block/grid layout, not a transformed
 * carousel or similar), so `fixed inset-0` here reliably covers the
 * true viewport rather than getting clipped/repositioned by a
 * transformed scroll container — the exact trap this round's brief
 * asked to check for. If a future ancestor ever gains a `transform`
 * (e.g. a page-transition wrapper), this modal would need to move to a
 * portal (`createPortal` into `document.body`) to keep working; no
 * portal is used here because none is currently needed.
 */
export function ImagePickerModal({
  imageOptions,
  selectedImageUrl,
  choosingUrl,
  uploading,
  onChoose,
  onUploadClick,
  onClose,
}: {
  imageOptions: string[];
  selectedImageUrl: string | null;
  /** URL currently mid-flight through chooseScrapedImage, or null. */
  choosingUrl: string | null;
  uploading: boolean;
  onChoose: (url: string) => void;
  onUploadClick: () => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-nearblack/40 p-4"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-full max-w-2xl flex-col border border-[#dcd6cc] bg-cream shadow-lg"
      >
        <div className="flex items-center justify-between border-b border-[#dcd6cc] px-5 py-3">
          <p className="label-caps !text-charcoal/50">
            Choose image · {imageOptions.length} found
          </p>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onUploadClick}
              disabled={uploading}
              className="border border-nearblack px-3 py-1.5 text-caption text-nearblack hover:bg-nearblack hover:text-white disabled:opacity-60"
            >
              {uploading ? "Uploading…" : "Upload new"}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="text-caption text-charcoal/50 hover:text-nearblack"
            >
              Close ✕
            </button>
          </div>
        </div>

        <div className="overflow-y-auto p-5">
          {imageOptions.length === 0 ? (
            <p className="text-body text-charcoal/50">
              No candidate images found yet — use "Upload new" above.
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
              {imageOptions.map((url) => {
                const isSelected = url === selectedImageUrl;
                const isChoosing = choosingUrl === url;
                return (
                  <button
                    key={url}
                    type="button"
                    disabled={isChoosing || isSelected}
                    onClick={() => onChoose(url)}
                    className={`relative aspect-square overflow-hidden border bg-cream disabled:cursor-default ${
                      isSelected
                        ? "border-nearblack ring-2 ring-nearblack"
                        : "border-[#dcd6cc] hover:border-nearblack"
                    }`}
                  >
                    <Image
                      src={url}
                      alt=""
                      fill
                      sizes="(min-width: 768px) 160px, 33vw"
                      className="object-cover"
                    />
                    {isSelected && (
                      <span className="absolute inset-x-0 bottom-0 bg-nearblack/80 py-1 text-center text-[10px] uppercase tracking-wide text-white">
                        In use
                      </span>
                    )}
                    {isChoosing && (
                      <span className="absolute inset-0 flex items-center justify-center bg-nearwhite/70 text-caption text-charcoal/60">
                        …
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
