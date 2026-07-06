import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { computeMaterialsNeedingAria } from "@/lib/board-cockpit";
import type { MaterialsNeedingAriaResponse } from "@/types/board-cockpit";

export const runtime = "nodejs";

/**
 * GET /api/materials/attention
 * Board cockpit round (7 July 2026) — 'price_refreshes_pending'
 * attention feed, companion to GET /api/board-tasks/attention's
 * 'bookings_overdue' (same thin-route + lib/*.ts pure-compute-function
 * shape — see lib/board-cockpit.ts's computeMaterialsNeedingAria() doc
 * comment). Team session, NO admin gate — same "not financial in the
 * per-field sense" reasoning GET /api/materials already uses for its
 * own team-visible access (materials.price is a supplier list/trade
 * price, not a negotiated admin-gated cost).
 *
 * Returns every material whose last automated price refresh failed
 * (price_refresh_status='needs_aria', set by POST /api/materials/[id]/
 * refresh-price on fetch failure/timeout — Bunnings/Wilbrad-type pages
 * are known to hang on plain fetch, see that route's doc comment) and
 * is still waiting on Aria (MCP tool submit_material_price) or a human
 * (PATCH /api/materials/[id] with a hand-entered price) to resolve it.
 */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: materials, error } = await supabase
    .from("materials")
    .select("id,name,price_refresh_status,price_refresh_requested_at")
    .is("deleted_at", null)
    .eq("price_refresh_status", "needs_aria");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const pending = computeMaterialsNeedingAria(materials ?? []);
  const body: MaterialsNeedingAriaResponse = { price_refreshes_pending: pending };
  return NextResponse.json(body);
}
