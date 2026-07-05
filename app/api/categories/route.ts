import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { invalidateCategoriesCache } from "@/lib/reference-data";

/** GET /api/categories — any authenticated team member. */
export async function GET() {
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { data, error } = await supabase
    .from("categories")
    .select("*")
    .order("sort_order");
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ categories: data });
}

/** POST /api/categories — admin only. body { prefix, name, sort_order? } */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (info.role !== "admin") {
    return NextResponse.json(
      { error: "Only admins can manage categories" },
      { status: 403 }
    );
  }

  const body = await request.json().catch(() => ({}));
  const prefix = String(body?.prefix ?? "").trim().toUpperCase();
  const name = String(body?.name ?? "").trim();
  if (!prefix || !name) {
    return NextResponse.json(
      { error: "prefix and name are required" },
      { status: 400 }
    );
  }

  const { data, error } = await supabase
    .from("categories")
    .insert({
      prefix,
      name,
      sort_order: Number(body?.sort_order) || 0,
    })
    .select()
    .single();

  if (error) {
    // 23505 = unique violation on prefix
    const msg =
      error.code === "23505"
        ? `Category prefix "${prefix}" already exists`
        : error.message;
    return NextResponse.json({ error: msg }, { status: 400 });
  }
  // Phase 14A caching: invalidate the cached reference-data read
  // (lib/reference-data.ts's getCategories()) so every page that
  // depends on it sees the new category immediately rather than
  // waiting out the cache's revalidate window.
  invalidateCategoriesCache();
  return NextResponse.json({ category: data }, { status: 201 });
}
