import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/auth";
import { normalizeProductUrl } from "@/lib/scraper";

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
  "trade_price_received_at",
  "trade_price_source",
]);
const NUMERIC = new Set([
  "width_mm",
  "height_mm",
  "length_mm",
  "depth_mm",
  "price_rrp",
  "price_trade",
]);

/**
 * Financial fields — admin-gated per BUILD-SPEC.md "Financial visibility
 * — role-gated" (price_trade is financial data; price_rrp is not). Kept
 * in sync with app/api/library/route.ts.
 */
const FINANCIAL_EDITABLE = new Set(["price_trade", "trade_price_received_at", "trade_price_source"]);
const FINANCIAL_FIELDS = ["price_trade", "trade_price_received_at", "trade_price_source"] as const;

function stripFinancials<T extends Record<string, unknown>>(item: T): T {
  const clone = { ...item };
  for (const f of FINANCIAL_FIELDS) delete clone[f];
  return clone;
}

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
  const admin = await isAdmin(supabase);

  const body = await request.json().catch(() => ({}));
  const update: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (!EDITABLE.has(k)) continue;
    // Non-admin sessions cannot write trade price / provenance, even if
    // present in the request body — server-side enforcement, not just
    // UI hiding (BUILD-SPEC.md: "enforced server-side").
    if (FINANCIAL_EDITABLE.has(k) && !admin) continue;
    if (NUMERIC.has(k)) {
      update[k] = v === "" || v === null ? null : Number(v);
    } else {
      update[k] = typeof v === "string" && v.trim() === "" ? null : v;
    }
  }

  // Entering/changing a trade price stamps trade_price_received_at to
  // today automatically, unless the caller explicitly supplied a date
  // (BUILD-SPEC.md: "Entering a trade price stamps the date
  // automatically (editable)").
  if (admin && "price_trade" in update && !("trade_price_received_at" in update)) {
    update.trade_price_received_at =
      update.price_trade === null ? null : new Date().toISOString().slice(0, 10);
  }

  if ("product_url" in update) {
    update.product_url_normalized = normalizeProductUrl(update.product_url as string | null);
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
  const payload = admin ? item : stripFinancials(item);
  return NextResponse.json({ item: payload });
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
