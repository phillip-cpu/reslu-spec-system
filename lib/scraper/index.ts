import { createServiceRoleClient } from "@/lib/supabase/server";
import { ensureStoredImage } from "@/lib/images";
import { reportError } from "@/lib/report-error";
import { fetchSafely, UnsafeUrlError } from "./guard";
import { extractFromHtml, type DetectedDocument } from "./extract";
import { normalizeProductUrl } from "./normalize";
import type { ScrapeStatus } from "@/types";

/**
 * Phase 1 scrape pipeline entry point (BUILD-SPEC.md: "fetch-first
 * scraping, never block item creation" + "Scraper extension — document
 * detection").
 *
 * Runs guard → fetch → extract, then updates the item:
 *   - image_options: merged with any existing options, deduped
 *   - price_rrp: only set if currently null — a manual entry is never
 *     overwritten by a scrape
 *   - scrape_status: 'success' if images were found, 'partial' if only
 *     some data (e.g. price but no images, or vice versa), 'failed'
 *     otherwise
 *   - scrape_attempted_at: always stamped
 *   - scrape_flagged + scrape_flag_note: set on failure so the register
 *     surfaces "add images manually"
 *   - scraped_documents: detected PDF links (spec sheets / install
 *     manuals / other), staged for one-click "Attach" in the UI
 *
 * NEVER throws — every failure path (bad URL, blocked host, timeout,
 * non-2xx, oversized response, extraction failure, DB write failure)
 * resolves to a 'failed' scrape_status update rather than propagating
 * an exception, because item creation/edits must never be blocked by
 * scrape outcomes. Callers that want to react to failure can inspect
 * the return value; fire-and-forget callers can safely ignore it.
 */

export interface ScrapeOutcome {
  ok: boolean;
  status: ScrapeStatus;
  note?: string;
}

const FAILURE_NOTE = "Auto-fetch failed — add images manually";

/** Note appended to scrape_flag_note when at least one dimension was auto-filled (BUILD-SPEC.md "Dimension extraction (best-effort)"). */
const DIMENSIONS_NOTE = "Dimensions auto-read — please verify";

export async function scrapeProductUrl(itemId: string, url: string): Promise<ScrapeOutcome> {
  const supabase = createServiceRoleClient();

  try {
    // Guard: validate scheme + resolve + block private ranges before the
    // first request; fetchSafely() re-validates on every redirect hop.
    const { bytes, contentType, finalUrl } = await fetchSafely(url, {
      accept: "text/html,application/xhtml+xml",
    });

    const isHtml = !contentType || /text\/html|application\/xhtml/i.test(contentType);
    if (!isHtml) {
      return await markFailed(supabase, itemId, "Product URL did not return an HTML page.");
    }

    const html = bytes.toString("utf-8");
    const { price, images, documents, dimensions } = extractFromHtml(html, finalUrl);

    // Fetch current item state so we merge (never overwrite manual data).
    const { data: current, error: fetchError } = await supabase
      .from("items")
      .select("image_options, price_rrp, selected_image_url, width_mm, height_mm, length_mm, depth_mm")
      .eq("id", itemId)
      .single();

    if (fetchError || !current) {
      return await markFailed(supabase, itemId, "Item not found during scrape.");
    }

    const existingImages: string[] = Array.isArray(current.image_options)
      ? current.image_options
      : [];
    const mergedImages = [...new Set([...existingImages, ...images])];

    const foundImages = images.length > 0;
    const foundPrice = price !== null;
    const status: ScrapeStatus = foundImages ? "success" : foundPrice || documents.length > 0 ? "partial" : "failed";

    const update: Record<string, unknown> = {
      image_options: mergedImages,
      scrape_status: status,
      scrape_attempted_at: new Date().toISOString(),
      scraped_documents: documents as DetectedDocument[],
    };

    // price_rrp: only fill if currently null — never overwrite a manual entry.
    if (current.price_rrp === null && price !== null) {
      update.price_rrp = price;
    }

    // Auto-select the best scraped image (first extracted = highest
    // priority source) when the item has none — user can swap from the
    // options grid at any time. Never overwrites an existing selection.
    // (auto-select happens below via ensureStoredImage so the stored,
    // hotlink-proof copy lands on the item — not the supplier's URL.)

    // Dimensions (best-effort, BUILD-SPEC.md "Dimension extraction
    // (best-effort)"): only fill fields that are CURRENTLY NULL — same
    // never-overwrite-manual-data rule as price_rrp above. Each of the
    // four fields is considered independently (a supplier page might
    // only publish width+height, leaving length/depth for the team to
    // measure/enter by hand).
    const DIM_FIELDS = ["width_mm", "height_mm", "length_mm", "depth_mm"] as const;
    let anyDimensionFilled = false;
    for (const field of DIM_FIELDS) {
      if (current[field] === null && dimensions[field] !== undefined) {
        update[field] = dimensions[field];
        anyDimensionFilled = true;
      }
    }

    if (status === "failed") {
      update.scrape_flagged = true;
      update.scrape_flag_note = FAILURE_NOTE;
    } else {
      // A successful/partial scrape clears any previous failure flag —
      // UNLESS dimensions were auto-filled this run, in which case the
      // dedicated dimensions note takes that slot instead (still with
      // scrape_flagged left false: this is an FYI, not a flag-for-review
      // per BUILD-SPEC.md's "WITHOUT setting scrape_flagged=true").
      update.scrape_flagged = false;
      update.scrape_flag_note = anyDimensionFilled ? DIMENSIONS_NOTE : null;
    }

    const { error: updateError } = await supabase.from("items").update(update).eq("id", itemId);

    // Auto-select: copy the best scraped image into our storage when the
    // item has none. Durable against supplier hotlink-blocking/URL rot.
    if (!current.selected_image_url && images.length > 0) {
      await ensureStoredImage(supabase, itemId, images[0]);
    }
    if (updateError) {
      return { ok: false, status: "failed", note: updateError.message };
    }

    return { ok: status !== "failed", status };
  } catch (err) {
    const note =
      err instanceof UnsafeUrlError
        ? "Product URL points to a disallowed address."
        : err instanceof Error
          ? err.message
          : "Unknown scrape error.";
    // Phase 14A error visibility: a blocked/disallowed URL is an
    // EXPECTED, already-handled outcome of this pipeline's own SSRF
    // guard (BUILD-SPEC.md's "never block item creation" — a bad
    // supplier link is routine, not a system fault) — logging every
    // one to app_errors would drown the admin "System health" panel in
    // noise from ordinary bad URLs. Only genuinely unexpected failures
    // (extraction bugs, unhandled exceptions) are recorded.
    if (!(err instanceof UnsafeUrlError)) {
      await reportError("scrape-pipeline", err);
    }
    return await markFailed(supabase, itemId, note);
  }
}

async function markFailed(
  supabase: ReturnType<typeof createServiceRoleClient>,
  itemId: string,
  note: string
): Promise<ScrapeOutcome> {
  try {
    await supabase
      .from("items")
      .update({
        scrape_status: "failed",
        scrape_attempted_at: new Date().toISOString(),
        scrape_flagged: true,
        scrape_flag_note: FAILURE_NOTE,
      })
      .eq("id", itemId);
  } catch {
    // Even the failure-write must not throw — this function guarantees
    // it never propagates an exception to the caller.
  }
  return { ok: false, status: "failed", note };
}

export { normalizeProductUrl };
