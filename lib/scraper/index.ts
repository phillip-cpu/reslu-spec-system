import { createServiceRoleClient } from "@/lib/supabase/server";
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
    const { price, images, documents } = extractFromHtml(html, finalUrl);

    // Fetch current item state so we merge (never overwrite manual data).
    const { data: current, error: fetchError } = await supabase
      .from("items")
      .select("image_options, price_rrp, selected_image_url")
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
    if (!current.selected_image_url && images.length > 0) {
      update.selected_image_url = images[0];
    }

    if (status === "failed") {
      update.scrape_flagged = true;
      update.scrape_flag_note = FAILURE_NOTE;
    } else {
      // A successful/partial scrape clears any previous failure flag.
      update.scrape_flagged = false;
      update.scrape_flag_note = null;
    }

    const { error: updateError } = await supabase.from("items").update(update).eq("id", itemId);
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
