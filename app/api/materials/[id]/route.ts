import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { PatchMaterialInput } from "@/types/round-b";

/** Whitelist for PATCH — same "whitelist not blacklist" convention as app/api/items/[id]/route.ts's EDITABLE_FIELDS. */
const EDITABLE_FIELDS = new Set(["name", "product_url", "unit", "price", "coverage_per_unit", "notes"]);
const NUMERIC_FIELDS = new Set(["price", "coverage_per_unit"]);
const TEXT_FIELDS = new Set(["name", "product_url", "unit", "notes"]);

/**
 * GET /api/materials/[id]
 */
export async function GET(
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

  return NextResponse.json({ material });
}

/**
 * PATCH /api/materials/[id]
 * body: partial PatchMaterialInput. Used both for hand-entered price
 * edits and, indirectly, by the refresh-price route (which writes
 * price/price_refreshed_at directly rather than round-tripping through
 * this handler, since it also needs to set price_refreshed_at, not in
 * this whitelist — see app/api/materials/[id]/refresh-price/route.ts).
 */
export async function PATCH(
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

  let body: PatchMaterialInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const update: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(body)) {
    if (!EDITABLE_FIELDS.has(key)) continue;

    if (NUMERIC_FIELDS.has(key)) {
      if (raw === "" || raw === null || raw === undefined) {
        update[key] = null;
      } else {
        const n = Number(raw);
        if (Number.isNaN(n)) {
          return NextResponse.json({ error: `${key} must be a number` }, { status: 400 });
        }
        update[key] = n;
      }
    } else if (TEXT_FIELDS.has(key)) {
      const trimmed = typeof raw === "string" ? raw.trim() : raw;
      update[key] = trimmed === "" ? null : trimmed;
    }
  }

  if ("name" in update && (update.name === null || update.name === undefined)) {
    return NextResponse.json({ error: "name cannot be empty" }, { status: 400 });
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "No editable fields in request" }, { status: 400 });
  }

  // A hand-entered price edit means this price is no longer "as of the
  // last refresh" — clear price_refreshed_at so the UI doesn't show a
  // stale "refreshed 3 days ago" caption next to a number that was
  // just hand-typed over the scraped one. Only when price itself is
  // part of THIS patch (editing product_url alone shouldn't touch it).
  //
  // Board cockpit round (migration 029) — a price edit ALSO resolves
  // any outstanding "needs_aria" refresh request the same way a
  // successful automated scrape would (see that migration's PART 3
  // comment): whether the new price came from a team member typing it
  // in here or from Aria's submit_material_price MCP tool (which PATCHes
  // this same route with { price, notes } — see mcp/src/index.mjs, this
  // round), the outstanding request is now resolved either way.
  if ("price" in update) {
    update.price_refreshed_at = null;
    update.price_refresh_status = null;
    update.price_refresh_requested_at = null;
  }

  const { data: material, error } = await supabase
    .from("materials")
    .update(update)
    .eq("id", id)
    .is("deleted_at", null)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!material) {
    return NextResponse.json({ error: "Material not found" }, { status: 404 });
  }

  return NextResponse.json({ material });
}

/**
 * DELETE /api/materials/[id]
 * Soft-delete — same convention as items/cost_lines/variations.
 * Materials already linked to an item/calculator input keep their id
 * valid (FKs are ON DELETE SET NULL where relevant) but the material
 * itself stops appearing in the materials picker list.
 */
export async function DELETE(
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

  const { error } = await supabase
    .from("materials")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .is("deleted_at", null);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

// Note: materials.product_url has no duplicate-detection column to
// keep in sync (no product_url_normalized on this table, unlike
// items — a much smaller, single-tenant reference list where
// duplicate detection wasn't judged worth a schema column). If that
// ever changes, mirror app/api/items/[id]/route.ts's
// normalizeProductUrl-on-write pattern here too.
