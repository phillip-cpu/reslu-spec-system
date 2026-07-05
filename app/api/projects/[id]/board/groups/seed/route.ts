import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { DEFAULT_PHASE_GROUPS } from "@/types/phase-12a-b";
import type { BoardGroup } from "@/types/phase-12a-b";

const SORT_STEP = 1000;

/**
 * POST /api/projects/[id]/board/groups/seed
 * Idempotent — seeds the default phase-group template (Site Prep,
 * Demolition, Rough-in, Waterproofing & Tiling, Fit-off, Handover) ONLY
 * if the project currently has zero board_groups rows. BUILD-SPEC.md
 * "Board v2" point 3: "Groups = construction phases, seeded per
 * project from a phase template ... on first visit". Called by the
 * Grouped list view's first render (components/board/ProjectBoard.tsx)
 * rather than folded into GET .../board (which every kanban-view load
 * also hits) — a project whose team only ever uses the Kanban view
 * should never accumulate six empty group rows it never asked for.
 * Response: { groups } — either the newly-seeded rows, or the
 * project's existing groups unchanged (safe to call repeatedly).
 */
export async function POST(
  _request: NextRequest,
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

  const { data: existing } = await supabase
    .from("board_groups")
    .select("*")
    .eq("project_id", projectId)
    .order("sort", { ascending: true });

  if (existing && existing.length > 0) {
    return NextResponse.json({ groups: existing as BoardGroup[] });
  }

  const seedRows = DEFAULT_PHASE_GROUPS.map((name, i) => ({
    project_id: projectId,
    name,
    sort: i * SORT_STEP,
  }));

  const { data: seeded, error } = await supabase.from("board_groups").insert(seedRows).select();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ groups: (seeded ?? []) as BoardGroup[] });
}
