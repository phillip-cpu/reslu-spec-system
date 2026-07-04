import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import type { CreateCostSectionInput } from "@/types";

/**
 * POST /api/projects/[id]/estimate/sections
 * Adds a new (freely-editable, per BUILD-SPEC.md "Fully editable per
 * project: add/remove/rename sections and lines freely") cost section
 * to a project's estimate. Appended to the end (max(sort)+1).
 *
 * Admin-only, per BUILD-SPEC.md §Financial visibility.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const supabase = await createClient();

  const info = await getUserRole(supabase);
  if (!info) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (info.role !== "admin") {
    return NextResponse.json(
      { error: "Only admins can access the Estimate module" },
      { status: 403 }
    );
  }

  let body: CreateCostSectionInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body?.name?.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const { data: existing } = await supabase
    .from("cost_sections")
    .select("sort")
    .eq("project_id", projectId)
    .order("sort", { ascending: false })
    .limit(1);
  const nextSort = (existing?.[0]?.sort ?? 0) + 1;

  const { data: section, error } = await supabase
    .from("cost_sections")
    .insert({ project_id: projectId, name: body.name.trim(), sort: nextSort })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(
    { section: { ...section, lines: [], rollup: { costExGst: 0, quotedExGst: 0, actualExGst: 0, variance: null } } },
    { status: 201 }
  );
}
