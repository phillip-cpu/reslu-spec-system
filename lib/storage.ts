/**
 * PRIVATE Supabase Storage bucket for item documents (spec sheets,
 * install manuals), project documents, and invoice PDFs — created by
 * migration 009_assets_bucket.sql (public: false). Every consumer
 * mints a short-TTL signed URL server-side per request
 * (createSignedUrl) rather than a permanent public URL; nothing reads
 * this bucket via getPublicUrl. Item/project COVER IMAGES are
 * deliberately NOT stored here — see PDF_IMAGE_BUCKET in lib/images.ts
 * (the public 'item-images' bucket) for anything whose URL gets
 * persisted and reused indefinitely (items.selected_image_url,
 * projects.cover_image_path use signed URLs minted server-side too,
 * but from a durable storage_path column, not a cached URL — see each
 * route for details).
 */
export const ASSET_BUCKET = "assets";

/** Default TTL for signed URLs minted from ASSET_BUCKET — long enough
 * for a team member to browse/open a document in one sitting, short
 * enough that a leaked link doesn't hand out a permanent download.
 * Mirrors the constant already used by app/portal/[token]/page.tsx. */
export const SIGNED_URL_TTL_SECONDS = 60 * 60;

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "application/pdf": "pdf",
};

export function extForMime(mime: string | null | undefined): string {
  return (mime && EXT_BY_MIME[mime.split(";")[0].trim()]) || "bin";
}

/** Timestamped, slugged object key — no Date in module scope callers pass ts. */
export function slugFilename(name: string): string {
  return name.replace(/[^a-z0-9.\-]+/gi, "-").replace(/-+/g, "-").toLowerCase();
}
