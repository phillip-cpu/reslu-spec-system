"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import type { ItemFile, ItemFileKind, ScrapedDocument } from "@/types";

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
  /**
   * Candidate image URLs found by the last product scrape
   * (items.image_options — up to 12, see lib/scraper/extract.ts
   * MAX_IMAGES). The scraper auto-picks the first one as
   * selected_image_url so an item never sits with no photo after a
   * successful scrape, but the other candidates are otherwise never
   * surfaced anywhere — this renders them as a picker so a team member
   * can swap in a better shot (e.g. a straight-on product photo instead
   * of a lifestyle image) without re-uploading manually.
   */
  imageOptions?: string[];
  /**
   * PDFs detected on the product page during scrape but not yet attached
   * (items.scraped_documents — BUILD-SPEC.md "Scraper extension —
   * document detection"). One-click "Attach" downloads server-side via
   * POST /api/items/[id]/files/from-url and adds a real item_files row.
   */
  scrapedDocuments?: ScrapedDocument[];
  onDocumentAttached?: (url: string) => void;
}

export function ItemAssets({
  itemId,
  selectedImageUrl,
  onImage,
  onError,
  imageOptions = [],
  scrapedDocuments = [],
  onDocumentAttached,
}: Props) {
  const [files, setFiles] = useState<FileWithUrl[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(true);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [attachingUrl, setAttachingUrl] = useState<string | null>(null);
  const [choosingUrl, setChoosingUrl] = useState<string | null>(null);
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

  /**
   * Picking a scraped candidate goes through the SAME re-host endpoint
   * as a manual upload (POST /api/items/[id]/image), just with a
   * `{ url }` JSON body instead of a file — that route already fetches
   * SSRF-safely and copies the result into the public item-images
   * bucket, so a chosen candidate never ends up hotlinking the
   * supplier's own site (BUILD-SPEC.md §6: "on selection, copy chosen
   * image into Supabase Storage").
   */
  async function chooseScrapedImage(sourceUrl: string) {
    setChoosingUrl(sourceUrl);
    onError(null);
    try {
      const res = await fetch(`/api/items/${itemId}/image`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: sourceUrl }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not use that image");
      const { url } = await res.json();
      onImage(url);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not use that image");
    } finally {
      setChoosingUrl(null);
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

  async function attachScraped(doc: ScrapedDocument) {
    setAttachingUrl(doc.url);
    onError(null);
    try {
      const res = await fetch(`/api/items/${itemId}/files/from-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: doc.url, kind: doc.guessedKind }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Attach failed");
      const { file: row } = await res.json();
      setFiles((cur) => [...cur, row]);
      onDocumentAttached?.(doc.url);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not attach document");
    } finally {
      setAttachingUrl(null);
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

        {/* Scraped image candidates (items.image_options) — the scraper
            auto-picks the first one, but the rest are otherwise
            invisible. Click any thumbnail to use it instead; the copy
            goes through the same re-host-into-Storage path as a manual
            upload (see chooseScrapedImage above), never a direct
            hotlink to the supplier's site. */}
        {imageOptions.length > 0 && (
          <div className="mt-3">
            <p className="mb-1.5 text-caption text-charcoal/50">
              {imageOptions.length} found — click to use
            </p>
            <div className="grid grid-cols-4 gap-2">
              {imageOptions.map((url) => {
                const isSelected = url === selectedImageUrl;
                const isChoosing = choosingUrl === url;
                return (
                  <button
                    key={url}
                    type="button"
                    disabled={isChoosing || isSelected}
                    onClick={() => chooseScrapedImage(url)}
                    className={`relative aspect-square overflow-hidden border bg-cream disabled:cursor-default ${
                      isSelected
                        ? "border-nearblack ring-1 ring-nearblack"
                        : "border-[#dcd6cc] hover:border-nearblack"
                    }`}
                  >
                    <Image
                      src={url}
                      alt=""
                      fill
                      sizes="80px"
                      className="object-cover"
                    />
                    {isSelected && (
                      <span className="absolute inset-x-0 bottom-0 bg-nearblack/80 py-0.5 text-center text-[10px] uppercase tracking-wide text-white">
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
          </div>
        )}
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

        {/* Detected-but-not-yet-attached PDFs from the last product scrape
            (BUILD-SPEC.md "Scraper extension — document detection"). */}
        {scrapedDocuments.length > 0 && (
          <div className="mt-3 border-t border-[#dcd6cc] pt-3">
            <p className="label-caps mb-1 text-sand">Found on product page</p>
            <ul className="space-y-1">
              {scrapedDocuments.map((doc) => (
                <li key={doc.url} className="flex items-center justify-between gap-2">
                  <span className="truncate text-body text-charcoal/70">
                    {KIND_LABELS[doc.guessedKind]}: {doc.label}
                  </span>
                  <button
                    type="button"
                    disabled={attachingUrl === doc.url}
                    onClick={() => attachScraped(doc)}
                    className="shrink-0 border border-nearblack px-2 py-1 text-caption text-nearblack hover:bg-nearblack hover:text-white disabled:opacity-60"
                  >
                    {attachingUrl === doc.url ? "Attaching…" : "Attach"}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
