import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { scrapeProductUrl } from "@/lib/scraper";
import type { ScrapeItemInput } from "@/types";

/**
 * Columns returned by this route — deliberately the same "Spec view"
 * shape as GET /api/projects/[id]/items (SPEC_VIEW_COLUMNS there),
 * plus the scraper-specific fields this route actually updates.
 * Explicitly excludes price_trade / markup_pct / lead_time_weeks /
 * ordered_at / eta / delivered_at / monday_* — this route is called by
 * any team member (not just admins) from the Spec register's "Fetch
 * details" button, so a `select("*")` here would leak financial and
 * procurement fields to non-admin sessions. price_rrp IS included —
 * it's a public reference price, not gated (see app/api/library/route.ts
 * for the fields that ARE gated).
 */
const SCRAPE_RESULT_COLUMNS = [
  "id",
  "project_id",
  "library_item_id",
  "item_code",
  "category",
  "name",
  "description",
  "supplier",
  "supplier_email",
  "brand",
  "quantity",
  "unit",
  "location",
  "application_note",
  "colour",
  "material",
  "finish",
  "width_mm",
  "height_mm",
  "length_mm",
  "depth_mm",
  "status",
  "product_url",
  "product_url_normalized",
  "selected_image_url",
  "image_options",
  "price_rrp",
  "scrape_status",
  "scrape_attempted_at",
  "scrape_flagged",
  "scrape_flag_note",
  "scraped_documents",
  "client_approved",
  "client_flagged",
  "client_flag_note",
  "client_actioned_at",
  "created_by",
  "created_at",
  "updated_at",
  "deleted_at",
].join(",");

/**
 * POST /api/items/[id]/scrape
 *
 * Phase 1 scrape pipeline (BUILD-SPEC.md: "fetch-first scraping, never
 * block item creation" + "Scraper extension — document detection").
 * Runs guard → fetch → extract (lib/scraper) and updates the item's
 * images, price_rrp (only if not already set manually), scrape status,
 * and any detected PDF documents.
 *
 * Auth required (team session). Validates the item exists and belongs
 * to an active (non-soft-deleted) record before scraping. Accepts an
 * optional { url } body override; falls back to the item's own
 * product_url. Returns the updated item — the scraper itself never
 * throws, so this route always responds with the (possibly unchanged)
 * item rather than a 500, even when the scrape fails outright.
 */
export async function POST(
  request: NextRequest,
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

  const { data: item } = await supabase
    .from("items")
    .select("id, product_url")
    .eq("id", id)
    .is("deleted_at", null)
    .single();

  if (!item) {
    return NextResponse.json({ error: "Item not found" }, { status: 404 });
  }

  let body: ScrapeItemInput = {};
  try {
    body = await request.json();
  } catch {
    // No body / non-JSON body is fine — fall back to the item's product_url.
  }

  const url = body?.url?.trim() || item.product_url;
  if (!url) {
    return NextResponse.json(
      {
        error:
          "No product URL to scrape — set product_url on the item or pass { url } in the request body.",
      },
      { status: 400 }
    );
  }

  // scrapeProductUrl never throws; it writes the outcome to the item row
  // itself (scrape_status/scrape_flagged/etc.) regardless of success.
  await scrapeProductUrl(id, url);

  const { data: updated, error } = await supabase
    .from("items")
    .select(SCRAPE_RESULT_COLUMNS)
    .eq("id", id)
    .single();

  if (error || !updated) {
    return NextResponse.json(
      { error: error?.message ?? "Item not found after scrape" },
      { status: 500 }
    );
  }

  return NextResponse.json({ item: updated });
}
