import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/library?q=&category=
 * Global product library (BUILD-SPEC.md §Everything else / Review §1.9).
 * Optional full-text-ish filter across name/brand/supplier.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const q = request.nextUrl.searchParams.get("q")?.trim();
  const category = request.nextUrl.searchParams.get("category")?.trim();

  let query = supabase
    .from("library_items")
    .select("*")
    .order("usage_count", { ascending: false })
    .order("name", { ascending: true })
    .limit(200);

  if (category) query = query.eq("category", category);
  if (q) {
    const like = `%${q}%`;
    query = query.or(
      `name.ilike.${like},brand.ilike.${like},supplier.ilike.${like}`
    );
  }

  const { data: items, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ items });
}

/** POST /api/library — create a library item. name + category required. */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  if (!body?.name?.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  if (!body?.category?.trim()) {
    return NextResponse.json({ error: "category is required" }, { status: 400 });
  }

  const toNum = (v: unknown) =>
    v === undefined || v === null || v === "" ? null : Number(v);
  const str = (v: unknown) =>
    typeof v === "string" && v.trim() ? v.trim() : null;

  const { data: item, error } = await supabase
    .from("library_items")
    .insert({
      name: body.name.trim(),
      category: body.category.trim(),
      description: str(body.description),
      supplier: str(body.supplier),
      supplier_email: str(body.supplier_email),
      brand: str(body.brand),
      colour: str(body.colour),
      material: str(body.material),
      finish: str(body.finish),
      width_mm: toNum(body.width_mm),
      height_mm: toNum(body.height_mm),
      length_mm: toNum(body.length_mm),
      depth_mm: toNum(body.depth_mm),
      product_url: str(body.product_url),
      default_image_url: str(body.default_image_url),
      price_rrp: toNum(body.price_rrp),
      price_trade: toNum(body.price_trade),
      created_by: user.id,
    })
    .select()
    .single();

  if (error) {
    const status = error.code === "23503" ? 400 : 500;
    return NextResponse.json({ error: error.message }, { status });
  }
  return NextResponse.json({ item }, { status: 201 });
}
