import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { DESIGN_PHASE_TEMPLATE, allPhaseProgress } from "@/lib/design-framework";
import { FALLBACK_DESIGN_TASK_TEMPLATES } from "@/lib/design-task-templates";
import type {
  DesignAssigneeSummary,
  DesignFrameworkResponse,
  DesignPhaseWithTasks,
  DesignTaskWithAssignees,
} from "@/types/phase-12b";
import type { DesignTaskTemplatesMap } from "@/types/round-c";

const SORT_STEP = 1000;
const TASK_SORT_STEP = 1000;

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
 *
 * "Two from Phillip — 7 July 2026" item 2 addition — "Design board
 * tasks pre-populated from the Monday template": immediately after
 * phases are freshly seeded above (the `phases.length === 0` branch —
 * this is intentionally INSIDE that branch, so it only ever runs
 * alongside phase seeding, never on a subsequent visit to an
 * already-seeded project, same "seed once, alongside the thing it
 * depends on" discipline lib/phase-seed.ts's own task-template seeding
 * uses for board_tasks/phase_task_templates), this route also reads
 * app_settings('design_task_templates') (falls back to
 * lib/design-task-templates.ts's FALLBACK_DESIGN_TASK_TEMPLATES if that
 * row is absent — a code-level fallback, not a migration seed; see that
 * file's header comment for why and where the seed content came from)
 * and, for each just-seeded phase whose name has a non-empty checklist,
 * inserts one design_tasks row per checklist item — unassigned, no due
 * date, sorted in list order. A phase name with no template entry (or
 * an empty one, e.g. "Sampling & Furniture") is simply skipped — no
 * fabricated checklist, same discipline lib/phase-seed.ts's own doc
 * comment states for its sibling mechanism.
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

    // "Two from Phillip — 7 July 2026" item 2 — seed each phase's task
    // checklist from app_settings('design_task_templates'), best-effort
    // (a single phase's template insert failing must not fail the
    // overall seed/response — the phases themselves already committed
    // above and are more important than their optional starter tasks).
    const { data: templatesRow } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "design_task_templates")
      .maybeSingle();
    const taskTemplates =
      (templatesRow?.value as DesignTaskTemplatesMap | undefined) ?? FALLBACK_DESIGN_TASK_TEMPLATES;

    for (const phase of phases) {
      const checklist = taskTemplates[phase.name];
      if (!checklist || checklist.length === 0) continue;
      const taskRows = checklist.map((item, i) => ({
        design_phase_id: phase.id,
        title: item.title,
        sort: i * TASK_SORT_STEP,
        created_by: null,
      }));
      await supabase.from("design_tasks").insert(taskRows);
    }
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

/**
 * POST /api/projects/[id]/design — apply the design task templates to
 * EXISTING phases that have no tasks yet. Backfill for projects whose
 * design phases seeded before templates existed (Phillip, 7 Jul:
 * "existing projects don't have the design line items, only headings").
 * Idempotent: only touches phases with zero non-deleted tasks; never
 * duplicates. Team auth, same as GET.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: phases } = await supabase
    .from("design_phases")
    .select("id,name")
    .eq("project_id", id);
  if (!phases || phases.length === 0) {
    return NextResponse.json({ error: "No design phases — open the Design tab first" }, { status: 400 });
  }

  const { data: templatesRow } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "design_task_templates")
    .maybeSingle();
  const taskTemplates =
    (templatesRow?.value as DesignTaskTemplatesMap | undefined) ?? FALLBACK_DESIGN_TASK_TEMPLATES;

  let created = 0;
  const skipped: string[] = [];
  for (const phase of phases) {
    const checklist = taskTemplates[phase.name];
    if (!checklist || checklist.length === 0) continue;
    const { count } = await supabase
      .from("design_tasks")
      .select("id", { count: "exact", head: true })
      .eq("design_phase_id", phase.id)
      .is("deleted_at", null);
    if ((count ?? 0) > 0) {
      skipped.push(phase.name);
      continue;
    }
    const taskRows = checklist.map((item, i) => ({
      design_phase_id: phase.id,
      title: item.title,
      sort: i * TASK_SORT_STEP,
      created_by: user.id,
    }));
    const { error } = await supabase.from("design_tasks").insert(taskRows);
    if (!error) created += taskRows.length;
  }

  return NextResponse.json({ created, skipped_phases_with_tasks: skipped });
}
