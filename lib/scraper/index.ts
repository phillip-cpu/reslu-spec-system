import { createServiceRoleClient } from "@/lib/supabase/server";
import { ensureStoredImage } from "@/lib/images";
import { reportError } from "@/lib/report-error";
import { fetchSafely, UnsafeUrlError } from "./guard";
import {
  extractFromHtml,
  type DetectedDocument,
  type ExtractedProductDetail,
} from "./extract";
import { normalizeProductUrl } from "./normalize";
import { friendlyFailureNote } from "./failure-note";
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
 *   - product_details / description / brand / dimensions: filled from
 *     structured supplier data without overwriting manual values
 *   - scrape_status: 'success' if images were found, 'partial' if useful
 *     product data was found without an image, 'failed' otherwise
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

/** Note appended to scrape_flag_note when at least one dimension was auto-filled (BUILD-SPEC.md "Dimension extraction (best-effort)"). */
const DIMENSIONS_NOTE = "Dimensions and product details auto-read — please verify";

function mergeProductDetails(
  current: unknown,
  scraped: ExtractedProductDetail[]
): ExtractedProductDetail[] {
  const existing = Array.isArray(current)
    ? current.filter(
        (entry): entry is ExtractedProductDetail =>
          !!entry &&
          typeof entry === "object" &&
          typeof (entry as ExtractedProductDetail).label === "string" &&
          typeof (entry as ExtractedProductDetail).value === "string"
      )
    : [];
  const seen = new Set(existing.map((entry) => entry.label.trim().toLowerCase()));
  const merged = [...existing];
  for (const entry of scraped) {
    const key = entry.label.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  return merged;
}

function detailValue(
  details: ExtractedProductDetail[],
  labels: string[]
): string | null {
  const wanted = new Set(labels.map((label) => label.toLowerCase()));
  return (
    details.find((detail) => wanted.has(detail.label.trim().toLowerCase()))?.value ??
    null
  );
}

function isLikelyMetresStoredAsMillimetres(current: unknown, scraped: number): boolean {
  const value = Number(current);
  if (!Number.isFinite(value) || value <= 0 || value >= 10 || scraped < 1000) return false;
  return Math.abs(scraped / value - 1000) < 0.01;
}

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
    const {
      price,
      images,
      documents,
      dimensions,
      description,
      brand,
      details,
    } = extractFromHtml(html, finalUrl);

    // Fetch current item state so we merge (never overwrite manual data).
    const { data: current, error: fetchError } = await supabase
      .from("items")
      .select(
        "image_options, product_details, price_rrp, selected_image_url, description, brand, colour, material, finish, width_mm, height_mm, length_mm, depth_mm"
      )
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
    const foundDimensions = Object.values(dimensions).some(
      (value) => value !== undefined
    );
    const foundProductContent = !!description || !!brand || details.length > 0;
    const foundAnything =
      foundImages ||
      foundPrice ||
      documents.length > 0 ||
      foundDimensions ||
      foundProductContent;
    const status: ScrapeStatus = foundImages
      ? "success"
      : foundAnything
        ? "partial"
        : "failed";

    const update: Record<string, unknown> = {
      image_options: mergedImages,
      product_details: mergeProductDetails(current.product_details, details),
      scrape_status: status,
      scrape_attempted_at: new Date().toISOString(),
      scraped_documents: documents as DetectedDocument[],
    };

    // price_rrp: only fill if currently null — never overwrite a manual entry.
    if (current.price_rrp === null && price !== null) {
      update.price_rrp = price;
    }
    if (!current.description && description) update.description = description;
    if (!current.brand && brand) update.brand = brand;
    if (!current.colour) {
      const colour = detailValue(details, ["colour", "color"]);
      if (colour) update.colour = colour;
    }
    if (!current.material) {
      const material = detailValue(details, ["material", "materials"]);
      if (material) update.material = material;
    }
    if (!current.finish) {
      const finish = detailValue(details, ["finish", "surface finish"]);
      if (finish) update.finish = finish;
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
      if (
        dimensions[field] !== undefined &&
        (current[field] === null ||
          isLikelyMetresStoredAsMillimetres(current[field], dimensions[field]))
      ) {
        update[field] = dimensions[field];
        anyDimensionFilled = true;
      }
    }

    if (status === "failed") {
      update.scrape_flagged = true;
      update.scrape_flag_note =
        "No price, image, dimensions or product specifications were found";
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
    if (updateError) {
      return { ok: false, status: "failed", note: updateError.message };
    }

    // Auto-select: copy the best scraped image into our storage when the
    // item has none. Durable against supplier hotlink-blocking/URL rot.
    if (!current.selected_image_url && images.length > 0) {
      try {
        await ensureStoredImage(supabase, itemId, images[0]);
      } catch (imageError) {
        // Image hotlinking/storage is a separate stage. Do not discard a
        // successfully extracted price, description or dimensions just
        // because the supplier blocked the image copy.
        await reportError("scrape-image-storage", imageError);
        await supabase
          .from("items")
          .update({
            scrape_flagged: true,
            scrape_flag_note:
              "Product details were found, but the image could not be stored — upload it manually",
          })
          .eq("id", itemId);
        return {
          ok: true,
          status,
          note: "Product details found; image storage failed.",
        };
      }
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
        scrape_flag_note: friendlyFailureNote(note),
      })
      .eq("id", itemId);
  } catch {
    // Even the failure-write must not throw — this function guarantees
    // it never propagates an exception to the caller.
  }
  return { ok: false, status: "failed", note };
}

export { normalizeProductUrl };
