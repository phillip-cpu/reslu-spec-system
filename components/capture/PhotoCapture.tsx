"use client";

import { useRef, useState } from "react";
import type { SiteCaptureWithUrl } from "@/types/site-captures";

/**
 * BUILD-SPEC.md item 1a/2 — "(a) photo — <input type='file'
 * accept='image/*' capture='environment' multiple> uploading
 * immediately with progress". One input covers both camera-direct
 * capture and picking from the library on mobile (capture is a hint,
 * not an exclusive mode — same as GalleryUploader's own camera input,
 * but that component splits camera/library into two separate inputs;
 * here BUILD-SPEC explicitly asks for ONE combined input carrying
 * both `capture` and `multiple`, so this deliberately does not mirror
 * GalleryUploader's two-button split).
 *
 * "Uploading immediately with progress": each selected file uploads
 * as its own POST /api/site-captures request, sequentially (simplest
 * accounting for a handful of on-site photos, same call/response
 * shape as POST /api/projects/[id]/site-photos' per-file loop) — the
 * button label shows "Uploading N of M…" while a batch is in flight.
 * This is a plain-fetch, count-based progress indicator (no XHR
 * byte-level progress bar) — consistent with this codebase's existing
 * "plain fetch, no upload-progress library" convention (every other
 * upload route/component here uses fetch, not XMLHttpRequest).
 */
export function PhotoCapture({
  projectId,
  onCaptured,
}: {
  projectId: string;
  onCaptured: (capture: SiteCaptureWithUrl) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function uploadFiles(files: File[]) {
    if (files.length === 0) return;
    setUploading(true);
    setError(null);
    setProgress({ done: 0, total: files.length });

    for (const file of files) {
      try {
        const form = new FormData();
        form.append("project_id", projectId);
        form.append("kind", "photo");
        form.append("file", file);
        const res = await fetch("/api/site-captures", { method: "POST", body: form });
        if (!res.ok) {
          throw new Error((await res.json().catch(() => ({}))).error ?? "Upload failed");
        }
        const body = await res.json();
        onCaptured(body.capture as SiteCaptureWithUrl);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Upload failed");
      } finally {
        setProgress((prev) => (prev ? { done: prev.done + 1, total: prev.total } : null));
      }
    }

    setUploading(false);
    setProgress(null);
  }

  return (
    <div>
      <p className="label-caps mb-2 text-sand">Photo</p>
      <button
        type="button"
        disabled={uploading}
        onClick={() => inputRef.current?.click()}
        className="flex w-full items-center justify-center gap-2 bg-nearblack px-5 py-8 text-subhead text-white transition-colors hover:bg-charcoal disabled:opacity-60"
      >
        {uploading && progress ? `Uploading ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…` : "Take / upload photo"}
      </button>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          void uploadFiles(files);
        }}
      />

      {error && <p className="mt-2 border border-red-700/40 bg-red-50 px-3 py-2 text-body text-red-700">{error}</p>}
    </div>
  );
}
