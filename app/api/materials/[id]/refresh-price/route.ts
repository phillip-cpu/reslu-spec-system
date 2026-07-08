import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { fetchSafely, UnsafeUrlError } from "@/lib/scraper/guard";
import { extractFromHtml } from "@/lib/scraper/extract";
import { reportError } from "@/lib/report-error";
import type { RefreshPriceResponse } from "@/types/round-b";
import { sendTeamEmail } from "@/lib/gmail/send";

/**
 * POST /api/materials/[id]/refresh-price
 * POST /api/materials/[id]/refresh-price?mode=supplier_quote
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
 *
 * `?mode=supplier_quote` ("Two more — 7 July 2026 evening", the Brick
 * calculator's "Request pricing via Aria" action): materials that need
 * a supplier quote (e.g. bulk/palletised items like bricks, priced
 * per-1000, that a plain product-page scrape can't sensibly cover)
 * skip the scrape attempt entirely — no product_url is required in
 * this mode — and go straight to the same needs_aria/requested_at
 * write + once-only email as a failed scrape, just with different
 * copy (subject "Supplier quote needed — {material}" instead of
 * "Price request — {material}", and body text asking for a supplier
 * quote/contact rather than "couldn't be fetched automatically").
 * Reuses the EXACT same needs_aria mechanism/columns/once-only guard
 * as the scrape-failure path below — this is a code-only addition
 * (no new migration, no new column): same `price_refresh_status`/
 * `price_refresh_requested_at` pair, just a different trigger and a
 * different email variant. The "Waiting for Aria" badge in
 * MaterialLinkControl.tsx already renders for ANY needs_aria row
 * regardless of which path set it, so no UI change was needed there.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const mode = request.nextUrl.searchParams.get("mode");
  const isSupplierQuote = mode === "supplier_quote";

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

  if (!isSupplierQuote && !material.product_url) {
    return NextResponse.json(
      { error: "This material has no product_url to refresh a price from" },
      { status: 400 }
    );
  }

  let note: string | undefined;
  let newPrice: number | null = null;

  if (isSupplierQuote) {
    // Supplier-quote mode never attempts a scrape — a bulk/palletised
    // material priced per-1000 (bricks, pavers, etc.) needs a human
    // quote, not a product-page price extraction; product_url may not
    // even be set. Falls straight through to the needs_aria write below
    // with newPrice left null, same as any other failed-refresh outcome.
    note = "Supplier quote requested.";
  } else {
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

  // Aria price-request notification (Phillip, 7 Jul): when a material
  // FLIPS to needs_aria (once per request — material.price_refresh_status
  // is the pre-update value, so a re-click while already queued doesn't
  // re-send), email her the lookup job. Best-effort like notifyClient:
  // sendTeamEmail no-ops without Gmail config and never throws here.
  //
  // Two more — 7 July 2026 evening: supplier-quote mode sends a DIFFERENT
  // email variant (subject "Supplier quote needed — {material}", body
  // asking for a supplier quote/contact rather than "couldn't be
  // fetched automatically") — same once-only guard, same columns, same
  // fire-and-forget send, just different copy for a different reason
  // the row is needs_aria. LIMITATION (documented per this round's own
  // "no schema" boundary): the brief asks this email to note "supplier
  // company/contact from linked contact if any" — but the `materials`
  // table (migration 027) has no contact_id/supplier-contact column at
  // all (confirmed: no such field exists anywhere on Material), so
  // there is no "linked contact" this route could read even if it
  // wanted to. Rather than invent one (which would need a migration —
  // explicitly out of scope this round), the email instead surfaces
  // whatever supplier info the material record DOES carry — product_url
  // and notes — and asks Aria to source/confirm the supplier contact
  // herself when neither is populated.
  if (
    newPrice === null &&
    material.price_refresh_status !== "needs_aria"
  ) {
    const requested = new Date().toLocaleDateString("en-AU", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
    const subject = isSupplierQuote
      ? `Supplier quote needed — ${material.name}`
      : `Price request — ${material.name}`;
    const body = isSupplierQuote
      ? [
          "Hi Aria,",
          "",
          "A supplier quote is required for current pricing on this material — it's",
          "priced/sold in a way (e.g. per 1000) that needs a supplier conversation",
          "rather than a product-page price check.",
          "",
          `Material: ${material.name}`,
          `Supplier / product reference: ${material.product_url ?? material.notes ?? "(none on file — please source a supplier contact for this material)"}`,
          `Requested: ${requested}`,
          "",
          "Once you have a quote, submit it with your submit_material_price tool",
          `(material_id: ${id}) or PATCH /api/materials/${id}.`,
          "",
          "— RESLU Spec System",
        ].join("\n")
      : [
          "Hi Aria,",
          "",
          "A material price couldn't be fetched automatically and needs manual lookup.",
          "",
          `Material: ${material.name}`,
          `Product URL: ${material.product_url ?? "(none on file)"}`,
          `Requested: ${requested}`,
          "",
          "Once you have the price, submit it with your submit_material_price tool",
          `(material_id: ${id}) or PATCH /api/materials/${id}.`,
          "",
          "— RESLU Spec System",
        ].join("\n");
    sendTeamEmail({
      to: ["aria@reslu.com.au"],
      subject,
      body,
    }).catch(() => {
      // best-effort by design
    });

    // RESLU Second Brain, Step 3 (docs/RESLU-second-brain-build-brief.md)
    // — "price request raised" event site. Alongside the existing email
    // above (not replacing it — this route's email notification predates
    // aria_queue and keeps working exactly as before), also raise a
    // price_request queue row so Aria's queue-driven flow (get_aria_queue)
    // picks this up without needing to parse an inbox.
    //
    // Payload/dedupe adapted from the brief's literal spec — the brief
    // assumed an `items` row ({item_id, project_id, supplier}), but this
    // event site is on `materials` (migration 027), which has no
    // project_id or supplier column at all (it's a global, non-project-
    // scoped commodity price list — see that migration's own header).
    // Using the real column names this table actually has instead of
    // inventing fields that don't exist. Dedupe is monthly (not weekly,
    // matching the brief's own literal `{yyyy-mm}` for this specific
    // event, unlike the weekly dedupe on the other two Step 3 events) —
    // on conflict do nothing, so a retry within the same month is a
    // silent no-op. Best-effort: never blocks or fails this route.
    const monthKey = new Date().toISOString().slice(0, 7); // yyyy-mm
    await supabase
      .from("aria_queue")
      .insert({
        kind: "price_request",
        payload: {
          material_id: id,
          material_name: material.name,
          product_url: material.product_url,
          mode: isSupplierQuote ? "supplier_quote" : "scrape_failed",
        },
        dedupe_key: `price_request:${id}:${monthKey}`,
        source: "materials.refresh-price",
      })
      .then(({ error: queueError }) => {
        if (queueError && queueError.code !== "23505") {
          // 23505 = unique_violation on dedupe_key, the expected/silent
          // "already queued this month" case — anything else is worth
          // knowing about, but still never blocks this route's response.
          reportError("materials-refresh-price-queue", new Error(queueError.message));
        }
      });
  }

  const payload: RefreshPriceResponse = {
    material: updated ?? material,
    ok: newPrice !== null,
    note,
  };

  return NextResponse.json(payload);
}
