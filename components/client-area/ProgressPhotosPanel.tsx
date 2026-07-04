"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";

interface Photo {
  id: string;
  url: string | null;
  caption: string | null;
  taken_at: string | null;
  created_at: string;
}

/**
 * Progress photos upload panel (BUILD-SPEC.md "Team-side client area":
 * "upload progress photos (multi-file, captions)"). Team-authenticated,
 * not admin-only.
 */
export function ProgressPhotosPanel({ projectId }: { projectId: string }) {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(true);
  const [caption, setCaption] = useState("");
  const [takenAt, setTakenAt] = useState("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch(`/api/projects/${projectId}/client-updates/photos`)
      .then((r) => r.json())
      .then((d) => setPhotos(d.photos ?? []))
      .catch(() => setError("Could not load progress photos."))
      .finally(() => setLoading(false));
  }, [projectId]);

  async function upload(files: FileList) {
    setUploading(true);
    setError(null);
    try {
      const fd = new FormData();
      for (const file of Array.from(files)) fd.append("files", file);
      if (caption.trim()) fd.append("caption", caption.trim());
      if (takenAt) fd.append("taken_at", takenAt);

      const res = await fetch(`/api/projects/${projectId}/client-updates/photos`, {
        method: "POST",
        body: fd,
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Upload failed");
      const { photos: created } = await res.json();
      setPhotos((cur) => [...created, ...cur]);
      setCaption("");
      setTakenAt("");
      if (fileInput.current) fileInput.current.value = "";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function remove(id: string) {
    const prev = photos;
    setPhotos((cur) => cur.filter((p) => p.id !== id));
    try {
      const res = await fetch(`/api/projects/${projectId}/client-updates/photos/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
    } catch {
      setPhotos(prev);
      setError("Could not remove photo.");
    }
  }

  if (loading) return <p className="text-body text-charcoal/50">Loading…</p>;

  return (
    <div className="space-y-4">
      {error && (
        <p className="border border-red-700/40 bg-red-50 px-4 py-2 text-body text-red-700">{error}</p>
      )}

      <div className="flex flex-wrap items-end gap-3 border border-[#dcd6cc] bg-nearwhite px-4 py-3">
        <div>
          <label className="label-caps mb-1 block !text-sand">Caption</label>
          <input
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            placeholder="Optional"
            className="w-56 border border-[#c9c2b4] bg-white px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
          />
        </div>
        <div>
          <label className="label-caps mb-1 block !text-sand">Taken</label>
          <input
            type="date"
            value={takenAt}
            onChange={(e) => setTakenAt(e.target.value)}
            className="border border-[#c9c2b4] bg-white px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
          />
        </div>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) upload(e.target.files);
          }}
        />
        <button
          type="button"
          disabled={uploading}
          onClick={() => fileInput.current?.click()}
          className="border border-nearblack px-4 py-2 text-subhead text-nearblack transition-colors hover:bg-nearblack hover:text-white disabled:opacity-60"
        >
          {uploading ? "Uploading…" : "Upload photos"}
        </button>
      </div>

      {photos.length === 0 ? (
        <p className="text-body text-charcoal/50">No progress photos yet.</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {photos.map((p) => (
            <div key={p.id} className="group relative aspect-square overflow-hidden bg-cream">
              {p.url && <Image src={p.url} alt={p.caption ?? ""} fill sizes="200px" className="object-cover" />}
              <button
                type="button"
                onClick={() => remove(p.id)}
                className="absolute right-1 top-1 bg-nearblack/70 px-2 py-1 text-caption text-white opacity-0 transition-opacity group-hover:opacity-100"
              >
                Remove
              </button>
              {p.caption && (
                <p className="absolute inset-x-0 bottom-0 truncate bg-nearblack/60 px-2 py-1 text-caption text-white">
                  {p.caption}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
