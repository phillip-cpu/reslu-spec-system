import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { CreateItemInput } from "@/types";

/**
 * GET /api/projects/[id]/items
 * Returns all active (non-soft-deleted) spec items for a project,
 * ordered by category then item code. Auth enforced by middleware;
 * RLS restricts to authenticated team sessions (team_all policy).
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

  const { data: items, error } = await supabase
    .from("items")
    .select("*")
    .eq("project_id", id)
    .is("deleted_at", null)
    .order("category", { ascending: true })
    .order("item_code", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ items });
}

/**
 * POST /api/projects/[id]/items
 * body: CreateItemInput (name + category required).
 *
 * item_code is deliberately NOT set here — the DB trigger
 * assign_item_code() generates it per project/category with a
 * race-safe counter (BUILD-SPEC.md §3). Pricing and procurement
 * fields are never accepted on this route; they belong to the
 * internal Pricing & Procurement view.
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

  let body: CreateItemInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const toNum = (v: unknown) =>
    v === undefined || v === null || v === "" ? null : Number(v);

  // If created from a library item, hydrate defaults from it (the request
  // body still wins for any field it supplies — e.g. a project-specific
  // location or quantity).
  let libraryDefaults: Record<string, unknown> = {};
  if (body.library_item_id) {
    const { data: lib } = await supabase
      .from("library_items")
      .select("*")
      .eq("id", body.library_item_id)
      .single();
    if (lib) {
      libraryDefaults = {
        category: lib.category,
        name: lib.name,
        description: lib.description,
        supplier: lib.supplier,
        supplier_email: lib.supplier_email,
        brand: lib.brand,
        colour: lib.colour,
        material: lib.material,
        finish: lib.finish,
        width_mm: lib.width_mm,
        height_mm: lib.height_mm,
        length_mm: lib.length_mm,
        depth_mm: lib.depth_mm,
        product_url: lib.product_url,
        selected_image_url: lib.default_image_url,
        price_rrp: lib.price_rrp,
        price_trade: lib.price_trade,
      };
    }
  }

  const category = (body.category ?? libraryDefaults.category) as string | undefined;
  const name = (body.name ?? libraryDefaults.name) as string | undefined;

  if (!name?.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  if (!category?.trim()) {
    return NextResponse.json({ error: "category is required" }, { status: 400 });
  }

  const pick = (bodyVal: string | undefined, libKey: string) =>
    bodyVal?.trim() || (libraryDefaults[libKey] as string | null) || null;

  const { data: item, error } = await supabase
    .from("items")
    .insert({
      project_id: id,
      category: category.trim(),
      name: name.trim(),
      description: pick(body.description, "description"),
      supplier: pick(body.supplier, "supplier"),
      supplier_email: pick(body.supplier_email, "supplier_email"),
      brand: pick(body.brand, "brand"),
      quantity: toNum(body.quantity) ?? 1,
      location: body.location?.trim() || null,
      application_note: body.application_note?.trim() || null,
      colour: pick(body.colour, "colour"),
      material: pick(body.material, "material"),
      finish: pick(body.finish, "finish"),
      width_mm: toNum(body.width_mm) ?? (libraryDefaults.width_mm as number | null) ?? null,
      height_mm: toNum(body.height_mm) ?? (libraryDefaults.height_mm as number | null) ?? null,
      length_mm: toNum(body.length_mm) ?? (libraryDefaults.length_mm as number | null) ?? null,
      depth_mm: toNum(body.depth_mm) ?? (libraryDefaults.depth_mm as number | null) ?? null,
      product_url: pick(body.product_url, "product_url"),
      selected_image_url: (libraryDefaults.selected_image_url as string | null) ?? null,
      price_rrp: (libraryDefaults.price_rrp as number | null) ?? null,
      price_trade: (libraryDefaults.price_trade as number | null) ?? null,
      library_item_id: body.library_item_id ?? null,
      created_by: user.id,
    })
    .select()
    .single();

  if (error) {
    // Foreign-key violation on category → 400 (unknown prefix), else 500.
    const status = error.code === "23503" ? 400 : 500;
    return NextResponse.json({ error: error.message }, { status });
  }

  // Track library usage (best-effort) and the project↔library link.
  if (body.library_item_id) {
    const { data: lib } = await supabase
      .from("library_items")
      .select("usage_count")
      .eq("id", body.library_item_id)
      .single();
    if (lib) {
      await supabase
        .from("library_items")
        .update({ usage_count: (lib.usage_count ?? 0) + 1 })
        .eq("id", body.library_item_id);
    }
    await supabase
      .from("project_library_items")
      .upsert(
        { project_id: id, library_item_id: body.library_item_id },
        { onConflict: "project_id,library_item_id" }
      );
  }

  return NextResponse.json({ item }, { status: 201 });
}
