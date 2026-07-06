import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { DESIGN_PHASE_TEMPLATE, allPhaseProgress } from "@/lib/design-framework";
import type {
  DesignAssigneeSummary,
  DesignFrameworkResponse,
  DesignPhaseWithTasks,
  DesignTaskWithAssignees,
} from "@/types/phase-12b";

const SORT_STEP = 1000;

/**
 * GET /api/projects/[id]/design
 * Phase 12b — Design Framework (BUILD-SPEC.md §"12b Design Framework",
 * docs/DESIGN-FRAMEWORK-BRIEF.md). Team access (not admin-gated — design
 * is team work, per this task's brief, and carries no pricing/financial
 * data at all).
 *
 * Seed-on-first-visit: if this project currently has zero design_phases
 * rows, the 7 brief phases (lib/design-framework.ts's
 * DESIGN_PHASE_TEMPLATE) are inserted here, in order, before the read —
 * same lazy pattern as board_columns (013) and the Board's Grouped-list
 * view (020/021), NOT the migration-time global seed schedule_phases'
 * app_settings('phase_template') uses (023), since design_phases is
 * genuinely per-project data with no global template row to seed at
 * migration time.
 *
 * Returns every phase (seeded or pre-existing) with its non-deleted
 * tasks nested (each task carrying its assignees), plus the team roster
 * for assignee pickers — one fetch renders the whole Design tab, same
 * shape as GET /api/office / GET /api/projects/[id]/board.
 */
export async function GET(
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

  const { data: project } = await supabase
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .single();
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const { data: existingPhases, error: existingError } = await supabase
    .from("design_phases")
    .select("*")
    .eq("project_id", projectId)
    .order("sort", { ascending: true });
  if (existingError) {
    return NextResponse.json({ error: existingError.message }, { status: 500 });
  }

  let phases = existingPhases ?? [];

  if (phases.length === 0) {
    const { data: seeded, error: seedError } = await supabase
      .from("design_phases")
      .insert(
        DESIGN_PHASE_TEMPLATE.map((name, i) => ({
          project_id: projectId,
          name,
          sort: (i + 1) * SORT_STEP,
        }))
      )
      .select();
    if (seedError) {
      return NextResponse.json({ error: seedError.message }, { status: 500 });
    }
    phases = (seeded ?? []).sort((a, b) => a.sort - b.sort);
  }

  const phaseIds = phases.map((p) => p.id);

  const { data: tasks } = phaseIds.length
    ? await supabase
        .from("design_tasks")
        .select("*")
        .in("design_phase_id", phaseIds)
        .is("deleted_at", null)
        .order("sort", { ascending: true })
    : { data: [] };

  const taskRows = tasks ?? [];
  const taskIds = taskRows.map((t) => t.id);

  // `email` is included alongside id/full_name (beyond what the Design
  // tab UI itself needs) so the create_design_task MCP tool can resolve
  // an `assignee_email` argument to a profile id from this same
  // response — mirrors GET /api/office's identical DesignTeamMember/
  // OfficeTeamMember pattern (this codebase has no standalone
  // GET /api/profiles listing route).
  const [{ data: team }, { data: assigneeLinks }] = await Promise.all([
    supabase.from("profiles").select("id,full_name,email").order("full_name"),
    taskIds.length
      ? supabase.from("design_task_assignees").select("task_id,profile_id").in("task_id", taskIds)
      : Promise.resolve({ data: [] as { task_id: string; profile_id: string }[] }),
  ]);

  const teamById = new Map((team ?? []).map((p) => [p.id, p]));

  const assigneesByTask = new Map<string, DesignAssigneeSummary[]>();
  for (const link of assigneeLinks ?? []) {
    const profile = teamById.get(link.profile_id);
    if (!profile) continue;
    const list = assigneesByTask.get(link.task_id) ?? [];
    list.push(profile);
    assigneesByTask.set(link.task_id, list);
  }

  const tasksWithAssignees: DesignTaskWithAssignees[] = taskRows.map((t) => ({
    ...t,
    assignees: assigneesByTask.get(t.id) ?? [],
  }));

  const tasksByPhase = new Map<string, DesignTaskWithAssignees[]>();
  for (const t of tasksWithAssignees) {
    const list = tasksByPhase.get(t.design_phase_id) ?? [];
    list.push(t);
    tasksByPhase.set(t.design_phase_id, list);
  }

  const phasesWithTasks: DesignPhaseWithTasks[] = phases.map((p) => ({
    ...p,
    tasks: tasksByPhase.get(p.id) ?? [],
  }));

  const body: DesignFrameworkResponse = {
    phases: phasesWithTasks,
    team: team ?? [],
  };

  // `progress` is derived, additive convenience for callers that only
  // want the compact per-phase chip data (e.g. DesignProgressCard could
  // fetch this route directly instead of duplicating the seed logic) —
  // not part of the DesignFrameworkResponse type since every existing
  // consumer (the Design tab itself) already has `phases` and computes
  // progress client-side via lib/design-framework.ts's allPhaseProgress
  // for free; this is a bonus field, safe to ignore.
  return NextResponse.json({ ...body, progress: allPhaseProgress(phasesWithTasks) });
}
