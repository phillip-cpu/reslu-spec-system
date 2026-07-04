import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";

/** PATCH /api/categories/[id] — admin only. body { name?, sort_order? } */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (info.role !== "admin") {
    return NextResponse.json(
      { error: "Only admins can manage categories" },
      { status: 403 }
    );
  }

  const body = await request.json().catch(() => ({}));
  const update: Record<string, unknown> = {};
  if (typeof body?.name === "string" && body.name.trim())
    update.name = body.name.trim();
  if (body?.sort_order !== undefined) update.sort_order = Number(body.sort_order);
  // prefix is intentionally immutable — item codes already reference it.

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("categories")
    .update(update)
    .eq("id", id)
    .select()
    .single();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ category: data });
}

/** DELETE /api/categories/[id] — admin only. Blocked if in use. */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (info.role !== "admin") {
    return NextResponse.json(
      { error: "Only admins can manage categories" },
      { status: 403 }
    );
  }

  const { error } = await supabase.from("categories").delete().eq("id", id);
  if (error) {
    // 23503 = still referenced by items / library_items
    const msg =
      error.code === "23503"
        ? "This category is in use by items and can't be deleted"
        : error.message;
    return NextResponse.json({ error: msg }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
