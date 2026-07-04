import type { SupabaseClient } from "@supabase/supabase-js";
import { safeFetch } from "@/lib/safe-fetch";
import { extForMime } from "@/lib/storage";

/**
 * PDF-time image storage guarantee.
 *
 * BUILD-SPEC.md §6 / Review §1.7: PDFs must embed images from Supabase
 * Storage, never fetch supplier sites at render time (slow, and a single
 * dead supplier link can blow the PDF route's timeout). Item selection
 * already copies images into Storage on upload
 * (app/api/items/[id]/image/route.ts), but older/imported/CSV-seeded
 * items can still carry an external `selected_image_url` that was never
 * copied in. This module is the safety net: called as a pre-pass by the
 * PDF route (app/api/projects/[id]/pdf/route.ts) for every item whose
 * selected_image_url is not already on our Supabase host, sequentially,
 * with a per-image try/catch so one bad image never fails the whole
 * PDF — it just gets skipped (BUILD-SPEC.md §10, no pricing/ordering
 * concerns here, purely a rendering-reliability requirement).
 *
 * Deliberately NOT called from the portal approve/flag flow — the task
 * that specced this module was explicit that copy-on-approve is not
 * wanted; images are copied on selection (existing behaviour) and,
 * as a backstop, in the PDF pre-pass only.
 */

const MAX_BYTES = 10 * 1024 * 1024; // 10MB cap
const FETCH_TIMEOUT_MS = 5_000; // 5s timeout — see safeFetch override below
const STORAGE_PREFIX = "pdf-images"; // path within the shared 'item-images' bucket

/** Bucket used specifically for PDF-pre-pass image copies. */
export const PDF_IMAGE_BUCKET = "item-images";

/** Races a promise against a hard timeout; rejects if the timeout wins. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Image fetch timed out")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * True if the URL already points at our own Supabase Storage host —
 * i.e. it's already durable and safe to embed directly, no copy needed.
 */
function isOurStorageHost(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname.endsWith(".supabase.co") &&
      parsed.pathname.includes("/storage/v1/object/")
    );
  } catch {
    return false;
  }
}

export interface EnsureStoredImageResult {
  /** Final URL to embed in the PDF — storage URL on success, null if skipped. */
  url: string | null;
  /** Whether a new copy was made (false if the URL was already ours, or on failure). */
  copied: boolean;
}

/**
 * Ensures `url` is available from our own Storage, downloading and
 * re-hosting it if it's external. Updates the item's selected_image_url
 * in the database on success so future PDF runs (and the portal/register)
 * benefit from the durable copy too.
 *
 * Never throws — callers get { url: null, copied: false } on any failure
 * (timeout, oversized, wrong content-type, blocked host, upload error)
 * and should simply omit the image rather than fail PDF generation.
 */
export async function ensureStoredImage(
  supabase: SupabaseClient,
  itemId: string,
  url: string | null | undefined
): Promise<EnsureStoredImageResult> {
  if (!url) return { url: null, copied: false };

  if (isOurStorageHost(url)) {
    // Already durable — nothing to do.
    return { url, copied: false };
  }

  try {
    // safeFetch's own internal timeout is 10s and isn't configurable from
    // the outside (lib/safe-fetch.ts is out of this module's file
    // boundary). The PDF pre-pass wants a tighter 5s-per-image budget so
    // one slow supplier host can't eat the route's overall time budget
    // across many items — enforced here by racing safeFetch against our
    // own timeout rather than touching the shared helper.
    const { bytes, contentType } = await withTimeout(
      safeFetch(url, { maxBytes: MAX_BYTES, accept: "image/*" }),
      FETCH_TIMEOUT_MS
    );

    if (!contentType || !contentType.startsWith("image/")) {
      return { url: null, copied: false };
    }
    if (bytes.byteLength === 0) {
      return { url: null, copied: false };
    }

    const ext = extForMime(contentType);
    const path = `${STORAGE_PREFIX}/${itemId}/${Date.now()}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from(PDF_IMAGE_BUCKET)
      .upload(path, bytes, { contentType, upsert: true });

    if (uploadError) {
      return { url: null, copied: false };
    }

    const { data } = supabase.storage.from(PDF_IMAGE_BUCKET).getPublicUrl(path);
    const storedUrl = data.publicUrl;

    // Best-effort: update the item so future renders (and the register/
    // portal) use the durable copy too. Failure here doesn't affect the
    // current PDF render — we already have `storedUrl` in hand.
    await supabase
      .from("items")
      .update({ selected_image_url: storedUrl })
      .eq("id", itemId)
      .then(
        () => {},
        () => {}
      );

    return { url: storedUrl, copied: true };
  } catch {
    // Timeout, blocked host, network error, oversized response, etc. —
    // never fail the PDF for one image.
    return { url: null, copied: false };
  }
}

/**
 * Runs ensureStoredImage sequentially (not in parallel — deliberate, per
 * spec: "sequentially with per-image try/catch") over every item missing
 * a stored copy. Returns a map of item id → final image URL to embed
 * (or undefined if there is none / it couldn't be fetched).
 */
export async function ensureStoredImagesForItems(
  supabase: SupabaseClient,
  items: { id: string; selected_image_url: string | null }[]
): Promise<Map<string, string | undefined>> {
  const result = new Map<string, string | undefined>();

  for (const item of items) {
    if (!item.selected_image_url) {
      result.set(item.id, undefined);
      continue;
    }
    if (isOurStorageHost(item.selected_image_url)) {
      result.set(item.id, item.selected_image_url);
      continue;
    }
    const { url } = await ensureStoredImage(
      supabase,
      item.id,
      item.selected_image_url
    );
    result.set(item.id, url ?? undefined);
  }

  return result;
}

// Re-exported for callers that want to budget their own overall timeout.
export const PDF_IMAGE_FETCH_TIMEOUT_MS = FETCH_TIMEOUT_MS;
