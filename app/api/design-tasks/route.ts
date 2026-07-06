import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { CreateDesignTaskInput, DesignAssigneeSummary, DesignTaskWithAssignees } from "@/types/phase-12b";

const SORT_STEP = 1000;

/**
 * POST /api/design-tasks
 * body: CreateDesignTaskInput — { design_phase_id (required), title
 * (required), description?, due_date?, assignee_ids? }.
 *
 * Auto-assign on create (mirrors Board v2's / Office board's exact
 * rule, BUILD-SPEC.md "Board v2" point 1, reused here per this task's
 * "auto-assign creator" requirement): when `assignee_ids` is OMITTED
 * entirely, the creator is assigned automatically. An explicit array
 * (including `[]`) overrides this outright.
 *
 * Team access (not admin-gated — design is team work).
 *
 * Aria-relevant: this is the route the `create_design_task` MCP tool
 * calls (see mcp/src/index.mjs and docs/ARIA.md's "Design Framework
 * (Phase 12b)" section).
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: CreateDesignTaskInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.design_phase_id || !body.title?.trim()) {
    return NextResponse.json({ error: "design_phase_id and title are required" }, { status: 400 });
  }

  const { data: phase } = await supabase
    .from("design_phases")
    .select("id")
    .eq("id", body.design_phase_id)
    .single();
  if (!phase) {
    return NextResponse.json({ error: "design_phase_id does not exist" }, { status: 400 });
  }

  const { data: maxRow } = await supabase
    .from("design_tasks")
    .select("sort")
    .eq("design_phase_id", body.design_phase_id)
    .is("deleted_at", null)
    .order("sort", { ascending: false })
    .limit(1)
    .maybeSingle();

  const nextSort = (maxRow?.sort ?? -SORT_STEP) + SORT_STEP;

  const assigneeIds = body.assignee_ids === undefined ? [user.id] : body.assignee_ids;

  const { data: task, error } = await supabase
    .from("design_tasks")
    .insert({
      design_phase_id: body.design_phase_id,
      title: body.title.trim(),
      description: body.description?.trim() || null,
      due_date: body.due_date || null,
      sort: nextSort,
      created_by: user.id,
    })
    .select()
    .single();

  if (error) {
    const status = error.code === "23503" ? 400 : 500;
    return NextResponse.json({ error: error.message }, { status });
  }

  let assignees: DesignAssigneeSummary[] = [];
  if (assigneeIds.length > 0) {
    const { error: assigneeError } = await supabase
      .from("design_task_assignees")
      .insert(assigneeIds.map((profileId) => ({ task_id: task.id, profile_id: profileId })));
    if (!assigneeError) {
      const { data: profiles } = await supabase
        .from("profiles")
        .select("id,full_name")
        .in("id", assigneeIds);
      assignees = profiles ?? [];
    }
  }

  const taskWithAssignees: DesignTaskWithAssignees = { ...task, assignees };
  return NextResponse.json({ task: taskWithAssignees }, { status: 201 });
}
