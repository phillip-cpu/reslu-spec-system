"use client";

import { useCallback, useEffect, useState } from "react";
import { GalleryUploader, type SitePhoto } from "./GalleryUploader";
import { GalleryGrid } from "./GalleryGrid";

/**
 * Top-level state holder for the internal Gallery tab (BUILD-SPEC.md
 * §"Phase 11 addition — site photo gallery" + §"mobile pass"). Wires
 * the uploader, the date-grouped grid, and the multi-select "Add to
 * diary draft" action together.
 *
 * "Add to diary draft" creates a NEW draft portal_update (status
 * 'draft', draft_source 'manual') pre-linked to the selected photos via
 * portal_update_photos, then sends the user to the client area's Diary
 * tab to write the rough notes and send to Aria — this keeps the
 * Gallery -> Diary handoff to one tap, matching BUILD-SPEC's phone-
 * first diary composer emphasis ("Diary composer ... picks its 1-2
 * images FROM this gallery").
 */
export function GalleryWorkspace({ projectId }: { projectId: string }) {
  const [photos, setPhotos] = useState<SitePhoto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [creatingDraft, setCreatingDraft] = useState(false);

  const reload = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/site-photos`);
      if (!res.ok) throw new Error("Could not load the gallery.");
      const { photos } = await res.json();
      setPhotos(photos as SitePhoto[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the gallery.");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    reload();
  }, [reload]);

  function toggleSelect(id: string) {
    setSelectedIds((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function patchPhoto(id: string, body: Record<string, unknown>) {
    setPhotos((cur) => cur.map((p) => (p.id === id ? { ...p, ...body } : p)));
    try {
      const res = await fetch(`/api/site-photos/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Update failed");
    } catch {
      reload();
    }
  }

  async function addToDiaryDraft() {
    if (selectedIds.size === 0) return;
    setCreatingDraft(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/client-updates/posts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Site update",
          body_richtext: "",
          photo_ids: [...selectedIds],
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Could not start a diary draft");
      }
      setSelecting(false);
      setSelectedIds(new Set());
      window.location.href = `/projects/${projectId}/client?tab=diary`;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start a diary draft");
    } finally {
      setCreatingDraft(false);
    }
  }

  return (
    <div className="space-y-6">
      <GalleryUploader
        projectId={projectId}
        onUploaded={(uploaded) => setPhotos((cur) => [...uploaded, ...cur])}
      />

      {error && (
        <p className="border border-red-700/40 bg-red-50 px-3 py-2 text-body text-red-700">{error}</p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#dcd6cc] pb-4">
        <span className="text-body text-charcoal/70">{photos.length} photos</span>
        {selecting ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={selectedIds.size === 0 || creatingDraft}
              onClick={addToDiaryDraft}
              className="bg-nearblack px-4 py-2 text-subhead text-white transition-colors hover:bg-charcoal disabled:opacity-50"
            >
              {creatingDraft ? "Starting…" : `Add ${selectedIds.size || ""} to diary draft`}
            </button>
            <button
              type="button"
              onClick={() => {
                setSelecting(false);
                setSelectedIds(new Set());
              }}
              className="px-3 py-2 text-subhead text-charcoal/60 hover:text-nearblack"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setSelecting(true)}
            className="border border-nearblack px-4 py-2 text-subhead text-nearblack transition-colors hover:bg-nearblack hover:text-white"
          >
            Select photos…
          </button>
        )}
      </div>

      {loading ? (
        <p className="text-body text-charcoal/50">Loading…</p>
      ) : (
        <GalleryGrid
          photos={photos}
          onCaptionChange={(id, caption) => patchPhoto(id, { caption })}
          onPublishToggle={(id, next) => patchPhoto(id, { published_to_portal: next })}
          selectable={selecting}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
        />
      )}
    </div>
  );
}
