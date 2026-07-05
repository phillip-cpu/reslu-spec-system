"use client";

import { useRef, useState } from "react";
import { compressImages } from "./compress";

export interface SitePhoto {
  id: string;
  project_id: string;
  storage_path: string;
  caption: string | null;
  taken_at: string;
  uploaded_by: string | null;
  published_to_portal: boolean;
  in_handover_pack: boolean;
  created_at: string;
  url: string | null;
}

/**
 * Two distinct upload actions (BUILD-SPEC.md §"mobile pass": "Gallery
 * upload = two actions: 'Take photo' (input capture='environment',
 * camera-direct) + 'Upload' (library/files, multi-select)."):
 *
 *   - "Take photo": a file input with capture="environment" — on a
 *     phone this opens the rear camera directly rather than a file
 *     picker, per BUILD-SPEC's explicit instruction. Single photo per
 *     tap (camera capture doesn't multi-select), tap again for another.
 *   - "Upload": a plain multi-select file input (library/existing
 *     photos), no capture attribute.
 *
 * Both paths compress client-side (max 2000px, canvas, no deps — see
 * ./compress.ts) before POSTing to /api/projects/[id]/site-photos.
 * Large, tap-friendly buttons — this is BUILD-SPEC's "ABOVE ALL"
 * mobile-first surface alongside the diary composer.
 */
export function GalleryUploader({
  projectId,
  onUploaded,
}: {
  projectId: string;
  onUploaded: (photos: SitePhoto[]) => void;
}) {
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(files: File[]) {
    if (files.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      const compressed = await compressImages(files);
      const form = new FormData();
      for (const f of compressed) form.append("files", f);

      const res = await fetch(`/api/projects/${projectId}/site-photos`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Upload failed");
      }
      const { photos } = await res.json();
      onUploaded(photos as SitePhoto[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-3">
        <button
          type="button"
          disabled={uploading}
          onClick={() => cameraInputRef.current?.click()}
          className="flex items-center justify-center gap-2 bg-nearblack px-4 py-4 text-subhead text-white transition-colors hover:bg-charcoal disabled:opacity-60"
        >
          {uploading ? "Uploading…" : "Take photo"}
        </button>
        <button
          type="button"
          disabled={uploading}
          onClick={() => fileInputRef.current?.click()}
          className="flex items-center justify-center gap-2 border border-nearblack px-4 py-4 text-subhead text-nearblack transition-colors hover:bg-nearblack hover:text-white disabled:opacity-60"
        >
          {uploading ? "Uploading…" : "Upload"}
        </button>
      </div>

      {/* Camera-direct: capture="environment" opens the rear camera on
          phones instead of a generic file picker. */}
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          void upload(files);
        }}
      />

      {/* Library upload — multi-select, no capture attribute. */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          void upload(files);
        }}
      />

      {error && (
        <p className="border border-red-700/40 bg-red-50 px-3 py-2 text-body text-red-700">{error}</p>
      )}
    </div>
  );
}
