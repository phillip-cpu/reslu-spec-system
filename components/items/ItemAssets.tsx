"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import type { ItemFile, ItemFileKind } from "@/types";

type FileWithUrl = ItemFile & { url: string };

const KIND_LABELS: Record<ItemFileKind, string> = {
  spec_sheet: "Spec sheet",
  install_manual: "Install manual",
  other: "Other",
};

interface Props {
  itemId: string;
  selectedImageUrl: string | null;
  onImage: (url: string) => void;
  onError: (msg: string | null) => void;
}

export function ItemAssets({ itemId, selectedImageUrl, onImage, onError }: Props) {
  const [files, setFiles] = useState<FileWithUrl[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(true);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [kind, setKind] = useState<ItemFileKind>("spec_sheet");
  const imageInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    fetch(`/api/items/${itemId}/files`)
      .then((r) => r.json())
      .then((d) => {
        if (active) setFiles(d.files ?? []);
      })
      .catch(() => {})
      .finally(() => active && setLoadingFiles(false));
    return () => {
      active = false;
    };
  }, [itemId]);

  async function uploadImage(file: File) {
    setUploadingImage(true);
    onError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/items/${itemId}/image`, {
        method: "POST",
        body: fd,
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Upload failed");
      const { url } = await res.json();
      onImage(url);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Image upload failed");
    } finally {
      setUploadingImage(false);
    }
  }

  async function uploadFile(file: File) {
    setUploadingFile(true);
    onError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("kind", kind);
      const res = await fetch(`/api/items/${itemId}/files`, {
        method: "POST",
        body: fd,
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Upload failed");
      const { file: row } = await res.json();
      setFiles((cur) => [...cur, row]);
      if (fileInput.current) fileInput.current.value = "";
    } catch (err) {
      onError(err instanceof Error ? err.message : "Document upload failed");
    } finally {
      setUploadingFile(false);
    }
  }

  async function removeFile(id: string) {
    const prev = files;
    setFiles((cur) => cur.filter((f) => f.id !== id));
    try {
      const res = await fetch(`/api/item-files/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
    } catch {
      setFiles(prev);
      onError("Could not remove document");
    }
  }

  return (
    <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
      {/* Image */}
      <div>
        <p className="label-caps mb-2">Image</p>
        <div className="flex items-start gap-3">
          <div className="relative h-24 w-24 shrink-0 overflow-hidden border border-[#dcd6cc] bg-cream">
            {selectedImageUrl ? (
              <Image
                src={selectedImageUrl}
                alt=""
                fill
                sizes="96px"
                className="object-cover"
              />
            ) : (
              <span className="flex h-full items-center justify-center text-caption text-charcoal/30">
                None
              </span>
            )}
          </div>
          <div className="space-y-2">
            <input
              ref={imageInput}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadImage(f);
              }}
            />
            <button
              type="button"
              disabled={uploadingImage}
              onClick={() => imageInput.current?.click()}
              className="border border-nearblack px-3 py-1.5 text-subhead text-nearblack hover:bg-nearblack hover:text-white disabled:opacity-60"
            >
              {uploadingImage ? "Uploading…" : selectedImageUrl ? "Replace image" : "Upload image"}
            </button>
            {selectedImageUrl && (
              <button
                type="button"
                onClick={() => onImage("")}
                className="block text-caption text-charcoal/50 hover:text-red-700"
              >
                Remove image
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Documents */}
      <div>
        <p className="label-caps mb-2">Documents</p>
        {loadingFiles ? (
          <p className="text-caption text-charcoal/40">Loading…</p>
        ) : files.length === 0 ? (
          <p className="text-caption text-charcoal/40">No documents yet.</p>
        ) : (
          <ul className="mb-3 space-y-1">
            {files.map((f) => (
              <li key={f.id} className="flex items-center justify-between gap-2">
                <a
                  href={f.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="truncate text-body text-nearblack underline decoration-charcoal/30 underline-offset-2 hover:decoration-nearblack"
                >
                  {KIND_LABELS[f.kind]}: {f.filename}
                </a>
                <button
                  type="button"
                  onClick={() => removeFile(f.id)}
                  className="shrink-0 text-caption text-charcoal/50 hover:text-red-700"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as ItemFileKind)}
            className="border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
          >
            <option value="spec_sheet">Spec sheet</option>
            <option value="install_manual">Install manual</option>
            <option value="other">Other</option>
          </select>
          <input
            ref={fileInput}
            type="file"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) uploadFile(f);
            }}
          />
          <button
            type="button"
            disabled={uploadingFile}
            onClick={() => fileInput.current?.click()}
            className="border border-nearblack px-3 py-1.5 text-subhead text-nearblack hover:bg-nearblack hover:text-white disabled:opacity-60"
          >
            {uploadingFile ? "Uploading…" : "Upload document"}
          </button>
        </div>
      </div>
    </div>
  );
}
