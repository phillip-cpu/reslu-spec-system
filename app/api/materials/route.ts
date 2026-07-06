import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { CreateMaterialInput } from "@/types/round-b";

/**
 * GET /api/materials
 * POST /api/materials
 *
 * BUILD-SPEC.md "Phillip's ideas list — 6 July 2026" item 4:
 * calculators incl. materials price list. `materials` (migration
 * 027_quantity_links_materials.sql) is a GLOBAL, not per-project, price
 * list — same "shared across every project" shape as `library_items`
 * (a timber profile or plasterboard sheet size's price doesn't belong
 * to one project) — so this route has no `[id]/materials` project
 * nesting.
 *
 * Auth: team session required for both GET and POST (same "team_all"
 * RLS shape as the rest of this codebase's Phase 1 tables) — materials
 * pricing is used by the Calculators feature to compute a cost
 * estimate, which is admin-gated one level up (the Estimate tab this
 * feature lives inside is already admin-only, see
 * app/(dashboard)/projects/[id]/estimate/page.tsx's isAdmin() check).
 * This route itself does not re-check admin, matching library_items'
 * own GET (team-visible reference data, not itself "financial" in the
 * per-field sense price_trade/markup_pct are) — `price` on a material
 * is a supplier's list/trade price for a bulk product, the same
 * visibility class as items.price_rrp (public reference price), not
 * items.price_trade (negotiated cost, admin-gated). If materials
 * pricing should be admin-only end to end, gate the Calculators tab's
 * *mount point* (already true — see EstimateWorkspace.tsx living
 * entirely inside the admin-gated estimate page) rather than this
 * shared reference-data route.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q");

  let query = supabase.from("materials").select("*").is("deleted_at", null);

  if (q && q.trim()) {
    const term = q.trim().replace(/[%_]/g, (m) => `\\${m}`);
    query = query.ilike("name", `%${term}%`);
  }

  const { data: materials, error } = await query.order("name", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ materials: materials ?? [] });
}

/**
 * POST /api/materials
 * body: CreateMaterialInput (name required). Used by the Calculators
 * panel's inline "add material" flow (link a material → if it doesn't
 * exist yet, create it with just a name + product_url, price filled in
 * later via refresh-price or a manual PATCH).
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: CreateMaterialInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const name = body.name?.trim();
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const toNum = (v: unknown) =>
    v === undefined || v === null || v === ("" as unknown) ? null : Number(v);

  const { data: material, error } = await supabase
    .from("materials")
    .insert({
      name,
      product_url: body.product_url?.trim() || null,
      unit: body.unit?.trim() || "ea",
      price: toNum(body.price),
      coverage_per_unit: toNum(body.coverage_per_unit),
      notes: body.notes?.trim() || null,
      created_by: user.id,
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ material }, { status: 201 });
}
