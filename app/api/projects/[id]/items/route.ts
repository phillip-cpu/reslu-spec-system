import { NextRequest, NextResponse, after } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { scrapeProductUrl, normalizeProductUrl } from "@/lib/scraper";
import type { CreateItemInput } from "@/types";

/**
 * Columns returned by the Spec register (BUILD-SPEC.md §1–2 / Week 2 scope):
 * design data only. Deliberately excludes price_rrp, price_trade, markup_pct,
 * lead_time_weeks, ordered_at, eta, delivered_at, monday_item_id,
 * monday_synced_at — those belong to the internal Pricing & Procurement
 * view and must never appear in this response, even for admins. An explicit
 * column list (not `select("*")`) is used so a future schema addition can
 * never leak into this endpoint by accident.
 */
const SPEC_VIEW_COLUMNS = [
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
  "selected_image_url",
  "image_options",
  "scrape_status",
  "scrape_attempted_at",
  "scrape_flagged",
  "scrape_flag_note",
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
 * GET /api/projects/[id]/items
 * Returns all active (non-soft-deleted) spec items for a project,
 * ordered by category then item code. Auth enforced by middleware;
 * RLS restricts to authenticated team sessions (team_all policy).
 *
 * Query filters: ?category=TW&status=Specced&q=basin — category and status
 * are exact matches against the stored values; q does a case-insensitive
 * partial match across name, item_code, supplier, and brand.
 */
export async function GET(
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

  const { searchParams } = new URL(request.url);
  const category = searchParams.get("category");
  const status = searchParams.get("status");
  const q = searchParams.get("q");

  let query = supabase
    .from("items")
    .select(SPEC_VIEW_COLUMNS)
    .eq("project_id", id)
    .is("deleted_at", null);

  if (category && category !== "all") {
    query = query.eq("category", category);
  }
  if (status && status !== "all") {
    query = query.eq("status", status);
  }
  if (q && q.trim()) {
    const term = q.trim().replace(/[%_]/g, (m) => `\\${m}`);
    query = query.or(
      `name.ilike.%${term}%,item_code.ilike.%${term}%,supplier.ilike.%${term}%,brand.ilike.%${term}%`
    );
  }

  const { data: items, error } = await query
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
      // Duplicate detection (BUILD-SPEC.md "Library — trade price capture
      // & duplicate detection"): keep normalised URL in sync wherever
      // product_url is set. Never blocks creation — normalize returns
      // null on unparsable input.
      product_url_normalized: normalizeProductUrl(pick(body.product_url, "product_url")),
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

  // Fetch-first scraping (BUILD-SPEC.md: "never block item creation" on
  // scrape outcome) — fire-and-forget, response already carries the
  // created item; the register picks up scrape_status via its own
  // polling/refresh. scrapeProductUrl never throws. Wrapped in
  // next/server's after() so the work isn't killed the instant the
  // response is sent on serverless runtimes (Vercel) — plain
  // `void scrapeProductUrl(...)` is not guaranteed to complete post-response
  // outside a long-lived server.
  if (item?.product_url) {
    after(() => scrapeProductUrl(item.id, item.product_url));
  }

  return NextResponse.json({ item }, { status: 201 });
}
