import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import type { ItemComponent } from "@/types/item-components";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (info.role !== "admin") {
    return NextResponse.json({ error: "Only admins can access assembly pricing" }, { status: 403 });
  }

  const { data, error } = await supabase
    .from("item_components")
    .select("*, items!inner(project_id,deleted_at)")
    .eq("items.project_id", projectId)
    .is("items.deleted_at", null)
    .is("deleted_at", null)
    .order("sort", { ascending: true })
    .order("created_at", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const components = (data ?? []).map((row) => {
    const { items: _items, ...component } = row;
    return component as ItemComponent;
  });
  return NextResponse.json({ components });
}
