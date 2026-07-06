import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { namesMatch } from "@/lib/phase-template";
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
 *
 * FIX ROUND A — phase unification invariant: creating a board group
 * ALSO creates (or links, if a matching unlinked phase already exists
 * — same case-insensitive name match migration 023's one-time backfill
 * used, via lib/phase-template.ts's namesMatch()) a schedule_phases
 * row, mirroring exactly what POST /api/projects/[id]/phases does in
 * reverse for creating a phase. See that route's GET doc comment
 * (app/api/projects/[id]/phases/route.ts) for THE INVARIANT in full.
 * The new linked phase gets a short default span (today, +4 days —
 * same "starting skeleton" default the shared seed path uses) since a
 * board group carries no dates of its own to derive one from; staff
 * are expected to set real dates on the Timeline tab afterwards.
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
  const trimmedName = body.name.trim();

  const { data: maxRow } = await supabase
    .from("board_groups")
    .select("sort")
    .eq("project_id", projectId)
    .order("sort", { ascending: false })
    .limit(1)
    .maybeSingle();

  const nextSort = (maxRow?.sort ?? -SORT_STEP) + SORT_STEP;

  // ---- Unification invariant: find/create the linked schedule_phases row FIRST ----
  const { data: unlinkedPhases } = await supabase
    .from("schedule_phases")
    .select("id,name")
    .eq("project_id", projectId)
    .eq("kind", "phase")
    .is("deleted_at", null);

  // "Unlinked" here means no board_groups row currently points at it.
  const { data: linkedPhaseIds } = await supabase
    .from("board_groups")
    .select("phase_id")
    .eq("project_id", projectId)
    .not("phase_id", "is", null);
  const linkedSet = new Set((linkedPhaseIds ?? []).map((r) => r.phase_id as string));

  const matchingPhase = (unlinkedPhases ?? []).find(
    (p) => !linkedSet.has(p.id) && namesMatch(p.name, trimmedName)
  );

  let phaseId: string | null = matchingPhase?.id ?? null;

  if (!phaseId) {
    const today = new Date();
    const start = today.toISOString().slice(0, 10);
    const end = new Date(today.getTime() + 4 * 86_400_000).toISOString().slice(0, 10);

    const { data: maxPhaseSort } = await supabase
      .from("schedule_phases")
      .select("sort")
      .eq("project_id", projectId)
      .is("deleted_at", null)
      .order("sort", { ascending: false })
      .limit(1)
      .maybeSingle();

    const { data: newPhase } = await supabase
      .from("schedule_phases")
      .insert({
        project_id: projectId,
        name: trimmedName,
        start_date: start,
        end_date: end,
        color_key: "sand",
        sort: (maxPhaseSort?.sort ?? -SORT_STEP) + SORT_STEP,
      })
      .select("id")
      .single();
    phaseId = newPhase?.id ?? null;
  }

  const { data: group, error } = await supabase
    .from("board_groups")
    .insert({ project_id: projectId, name: trimmedName, sort: nextSort, phase_id: phaseId })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ group }, { status: 201 });
}
