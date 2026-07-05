import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { CreateBoardGroupInput } from "@/types/phase-12a-b";

const SORT_STEP = 1000;

/**
 * POST /api/projects/[id]/board/groups
 * body: CreateBoardGroupInput — { name }. Response: { group } (201).
 * Manual single-group creation (e.g. adding a bespoke phase beyond the
 * default template) — the BULK seed-on-first-visit path is the
 * dedicated POST .../board/groups/seed route below, kept separate so a
 * client adding ONE custom group never accidentally re-triggers the
 * whole default template.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: project } = await supabase.from("projects").select("id").eq("id", projectId).single();
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  let body: CreateBoardGroupInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.name?.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const { data: maxRow } = await supabase
    .from("board_groups")
    .select("sort")
    .eq("project_id", projectId)
    .order("sort", { ascending: false })
    .limit(1)
    .maybeSingle();

  const nextSort = (maxRow?.sort ?? -SORT_STEP) + SORT_STEP;

  const { data: group, error } = await supabase
    .from("board_groups")
    .insert({ project_id: projectId, name: body.name.trim(), sort: nextSort })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ group }, { status: 201 });
}
