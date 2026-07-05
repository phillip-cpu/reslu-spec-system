import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/auth";
import { normalizeProductUrl } from "@/lib/scraper";

/**
 * Financial fields on library_items — admin-gated per BUILD-SPEC.md
 * "Financial visibility — role-gated": "Trade prices are financial
 * data → admin-gated like all pricing." / "API responses strip
 * financial fields for non-admin sessions (not merely hidden in UI).
 * Non-admins see no financials section at all."
 *
 * price_rrp is NOT gated — it's a public reference price, not the
 * negotiated trade cost. Only price_trade and its provenance
 * (received_at/source) are stripped for non-admin sessions.
 *
 * No admin-gating pattern existed elsewhere in the library API before
 * this change (GET previously did `select("*")` with no stripping at
 * all) — this establishes the pattern for library_items; see also
 * app/api/library/[id]/route.ts.
 */
const FINANCIAL_FIELDS = ["price_trade", "trade_price_received_at", "trade_price_source"] as const;

function stripFinancials<T extends Record<string, unknown>>(item: T): T {
  const clone = { ...item };
  for (const f of FINANCIAL_FIELDS) delete clone[f];
  return clone;
}

/**
 * GET /api/library?q=&category=&limit=&offset=
 * Global product library (BUILD-SPEC.md §Everything else / Review §1.9).
 * Optional full-text-ish filter across name/brand/supplier.
 *
 * Phase 14A pagination (BUILD-SPEC.md Phase 14 "pagination/windowing"):
 * the old hardcoded `.limit(200)` becomes the DEFAULT — every existing
 * caller (LibraryBrowser.tsx passes no limit/offset) sees byte-for-byte
 * the same behaviour as before (200 results max). `total` (exact count)
 * is returned alongside `items`, additive, so a future paged UI has
 * something to page against without a second round trip.
 */
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const admin = await isAdmin(supabase);

  const q = request.nextUrl.searchParams.get("q")?.trim();
  const category = request.nextUrl.searchParams.get("category")?.trim();

  const limitParam = Number(request.nextUrl.searchParams.get("limit"));
  const offsetParam = Number(request.nextUrl.searchParams.get("offset"));
  const limit =
    Number.isFinite(limitParam) && limitParam > 0
      ? Math.min(Math.floor(limitParam), MAX_LIMIT)
      : DEFAULT_LIMIT;
  const offset =
    Number.isFinite(offsetParam) && offsetParam > 0 ? Math.floor(offsetParam) : 0;

  let query = supabase
    .from("library_items")
    .select("*", { count: "exact" })
    .order("usage_count", { ascending: false })
    .order("name", { ascending: true })
    .range(offset, offset + limit - 1);

  if (category) query = query.eq("category", category);
  if (q) {
    const like = `%${q}%`;
    query = query.or(
      `name.ilike.${like},brand.ilike.${like},supplier.ilike.${like}`
    );
  }

  const { data: items, error, count } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const payload = admin ? items ?? [] : (items ?? []).map(stripFinancials);
  return NextResponse.json({ items: payload, total: count ?? payload.length, limit, offset });
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
  const admin = await isAdmin(supabase);

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

  const productUrl = str(body.product_url);

  // Trade price + provenance are admin-only on write too — a non-admin
  // POST body simply can't set them, regardless of what's in the body.
  const tradePrice = admin ? toNum(body.price_trade) : null;
  const tradePriceSource = admin ? str(body.trade_price_source) : null;
  // Entering a trade price stamps the date automatically (editable) —
  // BUILD-SPEC.md "Library — trade price capture": "Entering a trade
  // price stamps the date automatically (editable)."
  const tradePriceReceivedAt =
    admin && tradePrice !== null
      ? (body.trade_price_received_at as string | undefined)?.trim() ||
        new Date().toISOString().slice(0, 10)
      : null;

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
      product_url: productUrl,
      product_url_normalized: normalizeProductUrl(productUrl),
      default_image_url: str(body.default_image_url),
      price_rrp: toNum(body.price_rrp),
      price_trade: tradePrice,
      trade_price_received_at: tradePriceReceivedAt,
      trade_price_source: tradePriceSource,
      created_by: user.id,
    })
    .select()
    .single();

  if (error) {
    const status = error.code === "23503" ? 400 : 500;
    return NextResponse.json({ error: error.message }, { status });
  }
  const payload = admin ? item : stripFinancials(item);
  return NextResponse.json({ item: payload }, { status: 201 });
}
