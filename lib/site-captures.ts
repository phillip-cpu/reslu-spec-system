import type { SupabaseClient } from "@supabase/supabase-js";
import { SIGNED_URL_TTL_SECONDS, slugFilename } from "@/lib/storage";
import { signedRenditionUrl, RENDITION_SIZES } from "@/lib/image-url";
import type { SiteCapture, SiteCaptureWithUrl } from "@/types/site-captures";

/**
 * Site capture + mobile QoL round (r21). PRIVATE Supabase Storage
 * bucket for /capture and /trade/[token] captures (photos + audio
 * notes) — created by migration 050_site_captures.sql (public: false),
 * same "insert into storage.buckets" mechanism as `assets`
 * (009_assets_bucket.sql). Every consumer mints a short-TTL signed URL
 * server-side per request — nothing reads this bucket via
 * getPublicUrl, same discipline as ASSET_BUCKET (lib/storage.ts).
 * Kept SEPARATE from `assets` (rather than reusing it) because site
 * captures are their own bounded feature with their own bucket-level
 * RLS policies (migration 050) — mirrors how `item-images` is its own
 * bucket alongside `assets` rather than folding every upload into one
 * bucket.
 */
export const SITE_CAPTURES_BUCKET = "site-captures";

/** Timestamped, project-scoped, slugged object key — mirrors GalleryUploader/site-photos' `projects/{id}/site-photos/{ts}-{slug}` shape exactly, just under a `site-captures/` prefix instead. */
export function captureStoragePath(projectId: string, kind: "photo" | "audio", filename: string): string {
  return `projects/${projectId}/site-captures/${kind}/${Date.now()}-${slugFilename(filename)}`;
}

/**
 * Mints signed URLs for one capture row. Photo rows get BOTH a
 * grid-sized rendition (`thumb_url`, for the Site diary grid /
 * "today" strip) and a full-size `url` (opened on click) — see
 * lib/image-url.ts's signedRenditionUrl. Audio rows get only `url`
 * (played directly via <audio>). Note rows get neither (both null) —
 * they have no storage_path to sign. Any signing failure degrades to
 * null rather than throwing, matching every other createSignedUrl
 * call site's error-swallowing convention in this codebase (e.g.
 * GET /api/projects/[id]/site-photos's withUrl()).
 */
export async function withCaptureUrl(
  supabase: SupabaseClient,
  row: SiteCapture
): Promise<SiteCaptureWithUrl> {
  if (!row.storage_path) {
    return { ...row, url: null, thumb_url: null, author: null };
  }

  const { data, error } = await supabase.storage
    .from(SITE_CAPTURES_BUCKET)
    .createSignedUrl(row.storage_path, SIGNED_URL_TTL_SECONDS);
  const url = error ? null : (data?.signedUrl ?? null);

  let thumb_url: string | null = null;
  if (row.kind === "photo") {
    thumb_url = await signedRenditionUrl(
      supabase,
      SITE_CAPTURES_BUCKET,
      row.storage_path,
      SIGNED_URL_TTL_SECONDS,
      { width: RENDITION_SIZES.grid }
    );
    if (!thumb_url) thumb_url = url; // fall back to the full-size URL rather than no thumbnail at all
  }

  return { ...row, url, thumb_url, author: null };
}

/**
 * Adelaide-anchored calendar-day key ("YYYY-MM-DD", sortable/groupable)
 * for a timestamptz ISO string — same Intl.DateTimeFormat technique as
 * lib/order-by.ts's adelaideNowParts() (explicit timeZone, no Date-
 * object/local-timezone ambiguity between the Vercel server and a
 * browser in Adelaide). Used to group Site diary rows "by day" per
 * BUILD-SPEC.md item 4.
 */
export function adelaideDateKey(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Adelaide" }).format(new Date(iso));
}

/** Human day heading for a dateKey ("YYYY-MM-DD") — e.g. "11 July 2026". */
export function adelaideDayLabel(dateKey: string): string {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Adelaide",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(`${dateKey}T12:00:00Z`));
}

/** Compact per-row time label — e.g. "2:30 pm" — Adelaide wall-clock. */
export function adelaideTimeLabel(iso: string): string {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Adelaide",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })
    .format(new Date(iso))
    .toLowerCase()
    .replace(" ", "");
}
