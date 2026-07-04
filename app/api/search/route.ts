import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/search?q=
 * Lightweight global search across projects, project items, and the
 * library (Review §1.9: "Global search across projects/items/library").
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
  if (!q || q.length < 2) {
    return NextResponse.json({ projects: [], items: [], library: [] });
  }
  const like = `%${q}%`;

  const [projects, items, library] = await Promise.all([
    supabase
      .from("projects")
      .select("id,name,client_name,status")
      .neq("status", "archived")
      .or(`name.ilike.${like},client_name.ilike.${like}`)
      .limit(10),
    supabase
      .from("items")
      .select("id,item_code,name,category,location,project_id,projects(name)")
      .is("deleted_at", null)
      .or(
        `name.ilike.${like},item_code.ilike.${like},brand.ilike.${like},supplier.ilike.${like}`
      )
      .limit(20),
    supabase
      .from("library_items")
      .select("id,name,category,brand,supplier")
      .or(`name.ilike.${like},brand.ilike.${like},supplier.ilike.${like}`)
      .limit(20),
  ]);

  return NextResponse.json({
    projects: projects.data ?? [],
    items: items.data ?? [],
    library: library.data ?? [],
  });
}
