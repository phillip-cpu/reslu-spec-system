import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { fetchSafely, UnsafeUrlError } from "@/lib/scraper/guard";
import { extractFromHtml } from "@/lib/scraper/extract";
import { reportError } from "@/lib/report-error";
import type { RefreshPriceResponse } from "@/types/round-b";

/**
 * POST /api/materials/[id]/refresh-price
 *
 * BUILD-SPEC.md "Phillip's ideas list — 6 July 2026" item 4:
 * "'Refresh price' button → ... reuse lib/scraper price extraction on
 * the product_url (SSRF guards apply; failures flag, never block)".
 *
 * Reuses the SAME SSRF-guarded fetch (lib/scraper/guard.ts's
 * fetchSafely/UnsafeUrlError) and HTML price-extraction
 * (lib/scraper/extract.ts's extractFromHtml) the item scrape pipeline
 * already uses — see lib/scraper/index.ts scrapeProductUrl() for the
 * pattern this mirrors. Deliberately does NOT call scrapeProductUrl()
 * itself: that function writes to the `items` table by itemId: it has
 * no material-shaped equivalent and materials don't need image/
 * dimension/document extraction, only price — so this route calls the
 * lower-level extractFromHtml() directly and writes just
 * materials.price/price_refreshed_at, the minimum needed here.
 *
 * NEVER hard-fails the request per BUILD-SPEC.md "failures flag, never
 * block" — a bad/blocked URL, non-HTML response, or no price found all
 * resolve to a 200 with `ok: false` + a `note` explaining what
 * happened, rather than a 4xx/5xx. The one exception is genuine
 * request-shape errors (missing product_url, material not found),
 * which ARE real client errors, not scrape failures.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: material, error } = await supabase
    .from("materials")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .single();

  if (error || !material) {
    return NextResponse.json({ error: "Material not found" }, { status: 404 });
  }

  if (!material.product_url) {
    return NextResponse.json(
      { error: "This material has no product_url to refresh a price from" },
      { status: 400 }
    );
  }

  let note: string | undefined;
  let newPrice: number | null = null;

  try {
    const { bytes, contentType } = await fetchSafely(material.product_url, {
      accept: "text/html,application/xhtml+xml",
    });

    const isHtml = !contentType || /text\/html|application\/xhtml/i.test(contentType);
    if (!isHtml) {
      note = "Product URL did not return an HTML page.";
    } else {
      const html = bytes.toString("utf-8");
      const { price } = extractFromHtml(html, material.product_url);
      if (price === null) {
        note = "No price found on the product page.";
      } else {
        newPrice = price;
      }
    }
  } catch (err) {
    note =
      err instanceof UnsafeUrlError
        ? "Product URL points to a disallowed address."
        : err instanceof Error
          ? err.message
          : "Unknown error while refreshing price.";
    // Same reasoning as lib/scraper/index.ts: an UnsafeUrlError is an
    // expected, already-handled outcome of the SSRF guard (a bad
    // supplier link is routine here too), not worth polluting the
    // admin "System health" panel over. Anything else is unexpected.
    if (!(err instanceof UnsafeUrlError)) {
      await reportError("materials-refresh-price", err);
    }
  }

  // Board cockpit round (migration 029) — "needs_aria" fallback: a
  // successful refresh clears any outstanding request (price_refresh_
  // status back to null); a FAILED refresh (newPrice === null, whether
  // from a caught fetch/timeout error above or simply "no price found
  // on the page") sets price_refresh_status='needs_aria' +
  // price_refresh_requested_at=now() so Aria (MCP tool
  // submit_material_price) or a human can pick it up — see that
  // migration's PART 3 comment for the full "why" (Bunnings/Wilbrad-
  // type pages are VERIFIED to hang on plain fetch, not hypothetical).
  const update: Record<string, unknown> =
    newPrice !== null
      ? {
          price: newPrice,
          price_refreshed_at: new Date().toISOString(),
          price_refresh_status: null,
          price_refresh_requested_at: null,
        }
      : {
          price_refresh_status: "needs_aria",
          price_refresh_requested_at: new Date().toISOString(),
        };

  const { data: updated, error: updateError } = await supabase
    .from("materials")
    .update(update)
    .eq("id", id)
    .select()
    .single();

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  const payload: RefreshPriceResponse = {
    material: updated ?? material,
    ok: newPrice !== null,
    note,
  };

  return NextResponse.json(payload);
}
