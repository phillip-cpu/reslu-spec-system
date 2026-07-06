import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { seedPhaseTemplateIfEmpty } from "@/lib/phase-seed";
import type { BoardGroup } from "@/types/phase-12a-b";

/**
 * POST /api/projects/[id]/board/groups/seed
 * Idempotent — seeds the editable phase template (app_settings key
 * 'phase_template', migration 023; default: Site Setup umbrella,
 * Demolition, Rough-in, Waterproofing & Tiling, Fit-off, Handover) ONLY
 * if the project currently has zero schedule_phases rows. BUILD-SPEC.md
 * "Board v2" point 3 / Fix Round A "Pre-populated phases": "phase
 * template seeded on first Timeline OR Board-grouped visit (shared
 * seed path)". Called by the Grouped list view's first render
 * (components/board/ProjectBoard.tsx) rather than folded into
 * GET .../board (which every kanban-view load also hits) — a project
 * whose team only ever uses the Kanban view should never accumulate
 * seeded group/phase rows it never asked for. Response: { groups } —
 * either the newly-seeded rows (each linked to a schedule_phases row —
 * see lib/phase-seed.ts's seedPhaseTemplateIfEmpty, the SAME function
 * GET /api/projects/[id]/phases and the Timeline page call), or the
 * project's existing groups unchanged (safe to call repeatedly).
 *
 * FIX ROUND A CHANGE from the original Week-9/Board-v2 version of this
 * route: the seed check used to be "zero board_groups rows"; it is now
 * "zero schedule_phases rows" (seedPhaseTemplateIfEmpty's own
 * idempotency check) — per THE INVARIANT (see
 * app/api/projects/[id]/phases/route.ts's GET doc comment),
 * board_groups and schedule_phases are unified, so seeding is keyed off
 * whichever table a project has touched FIRST, not board_groups
 * specifically. A project that already seeded via the Timeline tab
 * hitting this route afterwards is a no-op (schedule_phases is
 * non-empty), same idempotent guarantee as before, just checked on the
 * unified concept instead of one half of it.
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

  await seedPhaseTemplateIfEmpty(supabase, projectId);

  const { data: groups, error } = await supabase
    .from("board_groups")
    .select("*")
    .eq("project_id", projectId)
    .order("sort", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ groups: (groups ?? []) as BoardGroup[] });
}
