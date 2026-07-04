import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const EDITABLE = new Set([
  "name",
  "category",
  "description",
  "supplier",
  "supplier_email",
  "brand",
  "colour",
  "material",
  "finish",
  "width_mm",
  "height_mm",
  "length_mm",
  "depth_mm",
  "product_url",
  "default_image_url",
  "price_rrp",
  "price_trade",
]);
const NUMERIC = new Set([
  "width_mm",
  "height_mm",
  "length_mm",
  "depth_mm",
  "price_rrp",
  "price_trade",
]);

/** PATCH /api/library/[id] */
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

  const body = await request.json().catch(() => ({}));
  const update: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (!EDITABLE.has(k)) continue;
    if (NUMERIC.has(k)) {
      update[k] = v === "" || v === null ? null : Number(v);
    } else {
      update[k] = typeof v === "string" && v.trim() === "" ? null : v;
    }
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const { data: item, error } = await supabase
    .from("library_items")
    .update(update)
    .eq("id", id)
    .select()
    .single();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ item });
}

/** DELETE /api/library/[id] — hard delete (library is a reference catalogue). */
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

  const { error } = await supabase.from("library_items").delete().eq("id", id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
