/** Public Supabase Storage bucket for item images and documents. */
export const ASSET_BUCKET = "assets";

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
