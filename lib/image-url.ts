import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Phase 14A — image renditions.
 * BUILD-SPEC.md Phase 14 "Speed": "image renditions everywhere" /
 * "Spec view thumbnails ... serve a resized ~80px rendition via
 * Supabase image transforms, not the full-size file — keeps the grid
 * fast."
 *
 * This app stores images in two different trust tiers (see
 * lib/storage.ts's header comment and lib/images.ts):
 *   - PUBLIC: the `item-images` bucket (items.selected_image_url,
 *     library_items.default_image_url, projects.cover_image_path) —
 *     durable URLs already handed out via getPublicUrl(), safe to
 *     reuse indefinitely.
 *   - PRIVATE: the `assets` bucket (site_photos, progress_photos,
 *     project_files, item_files, portal_update_photos, handover
 *     files) — every consumer mints a short-TTL signed URL server-side
 *     per request (createSignedUrl).
 *
 * Supabase's image transform endpoint (`/storage/v1/render/image/...`
 * for public objects, or the `transform` option on createSignedUrl for
 * private objects) resizes/re-encodes on the fly and is cached at the
 * edge — this is what actually makes list/grid contexts fast; without
 * it every thumbnail ships the full-size original.
 *
 * Both helpers below are additive and degrade gracefully: if a URL
 * isn't a Supabase Storage URL at all (e.g. an un-migrated external
 * supplier image still sitting in `items.selected_image_url` before
 * the PDF pre-pass copies it — see lib/images.ts), renditionUrl()
 * returns the input unchanged rather than producing a broken URL.
 * Requires Supabase's paid image transformation add-on to actually
 * resize; if that add-on isn't enabled the endpoint still serves the
 * original bytes, so this never hard-breaks images either way — it's
 * a pure performance layer, not a correctness dependency.
 */

export interface RenditionOptions {
  /** Target width in px. Height is omitted so aspect ratio is preserved
   * unless `height` is also given. */
  width: number;
  height?: number;
  /** Supabase's resize mode — 'cover' (default) crops to fill exactly
   * width×height, 'contain' fits within, 'fill' stretches. */
  resize?: "cover" | "contain" | "fill";
  /** Output quality 20-100 (Supabase default ~80). */
  quality?: number;
}

const SUPABASE_STORAGE_MARKER = "/storage/v1/object/public/";

/**
 * Rewrites a PUBLIC Supabase Storage URL
 * (".../storage/v1/object/public/<bucket>/<path>") into its transform
 * equivalent (".../storage/v1/render/image/public/<bucket>/<path>?width=..."),
 * which Supabase serves resized + edge-cached.
 *
 * Non-Supabase URLs (external supplier CDNs that haven't been copied
 * into our Storage yet) are returned unchanged — callers still get a
 * working <Image> src, just without the size benefit until the image
 * is copied into Storage (item selection / PDF pre-pass already do
 * this — see lib/images.ts).
 */
export function renditionUrl(
  url: string | null | undefined,
  opts: RenditionOptions
): string | null {
  if (!url) return null;

  const markerIndex = url.indexOf(SUPABASE_STORAGE_MARKER);
  if (markerIndex === -1) {
    // Not one of our public Storage URLs (external host, or already a
    // render/image URL, or a private-bucket signed URL — those go
    // through signedRenditionUrl below instead). Return as-is.
    return url;
  }

  const [base, existingQuery] = url.split("?");
  const rewritten = base.replace(
    SUPABASE_STORAGE_MARKER,
    "/storage/v1/render/image/public/"
  );

  const params = new URLSearchParams(existingQuery);
  params.set("width", String(Math.round(opts.width)));
  if (opts.height) params.set("height", String(Math.round(opts.height)));
  params.set("resize", opts.resize ?? "cover");
  if (opts.quality) params.set("quality", String(opts.quality));

  return `${rewritten}?${params.toString()}`;
}

/**
 * PRIVATE-bucket equivalent: mints a signed URL with an inline resize
 * transform in one call, for storage_path-based rows (site_photos,
 * progress_photos, portal_update_photos, handover gallery). Use this
 * in place of a bare `createSignedUrl(path, ttl)` call wherever the
 * result is rendered as a grid/list thumbnail rather than a full-size
 * lightbox image or a downloadable document.
 *
 * Returns null on any storage error (matches every existing
 * createSignedUrl call site's error-swallowing convention — see e.g.
 * app/portal/[token]/page.tsx, which already skips a photo/file
 * entirely rather than rendering a broken link).
 */
export async function signedRenditionUrl(
  supabase: SupabaseClient,
  bucket: string,
  path: string,
  ttlSeconds: number,
  opts: RenditionOptions
): Promise<string | null> {
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, ttlSeconds, {
    transform: {
      width: Math.round(opts.width),
      height: opts.height ? Math.round(opts.height) : undefined,
      resize: opts.resize ?? "cover",
      quality: opts.quality,
    },
  });
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}

/** Common thumbnail sizes used across list/grid surfaces — keep call
 * sites consistent rather than each picking arbitrary numbers. */
export const RENDITION_SIZES = {
  /** Spec register-style small thumbnail (~80px per BUILD-SPEC.md). */
  thumb: 80,
  /** Card cover images (dashboard ProjectCard, gallery/library cards). */
  card: 480,
  /** Grid tiles (gallery grid, portal photo grids, procurement cards). */
  grid: 240,
} as const;
