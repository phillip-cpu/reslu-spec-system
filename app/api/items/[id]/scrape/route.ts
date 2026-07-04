import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * POST /api/items/[id]/scrape
 *
 * Stub for Week 2. The real pipeline (fetch product_url → extract images +
 * RRP, non-blocking, per BUILD-SPEC.md / original brief §Scraping Pipeline)
 * lands in Week 3, along with the document-detection extension (spec sheet /
 * install manual PDF links on the product page). This route exists now so
 * the API surface is stable — the "Fetch details" button in the item panel
 * can be wired up today and will start working without a client-side change
 * once the real implementation ships.
 *
 * Still requires a session and validates the item exists, so the route is
 * exercised end-to-end (auth, 404s) even though the scrape itself doesn't
 * run yet. Never mutates the item — matches the brief's "never block item
 * creation on scrape outcome" principle by simply doing nothing yet.
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

  const { data: item } = await supabase
    .from("items")
    .select("id")
    .eq("id", id)
    .is("deleted_at", null)
    .single();

  if (!item) {
    return NextResponse.json({ error: "Item not found" }, { status: 404 });
  }

  return NextResponse.json(
    { error: "Scraper lands in Week 3", status: "not_implemented" },
    { status: 501 }
  );
}
