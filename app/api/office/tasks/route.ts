import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { CreateOfficeTaskInput, OfficeAssigneeSummary, OfficeTaskWithRefs } from "@/types/phase-13";

const SORT_STEP = 1000;

/**
 * POST /api/office/tasks
 * body: CreateOfficeTaskInput — { group_id (required), title (required),
 * description?, kind? ('task' default | 'rule'), due_date?, assignee_ids? }.
 *
 * Auto-assign on create (mirrors Board v2's exact rule, BUILD-SPEC.md
 * "Board v2" point 1, reused here per this task's brief "reuse
 * patterns"): when `assignee_ids` is OMITTED entirely, the creator is
 * assigned automatically. An explicit array (including `[]`) overrides
 * this outright. Standing rule cards (`kind: 'rule'`) never carry
 * assignees regardless of what's passed — a rule is a caution notice,
 * not a to-do someone owns.
 *
 * Aria-relevant: this is the route the `create_office_task` MCP tool
 * calls for her stated 24-48h inbound-work resolution pattern
 * (docs/ARIA.md / docs/OFFICE-BRIEF.md "What Aria automates today").
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: CreateOfficeTaskInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.group_id || !body.title?.trim()) {
    return NextResponse.json({ error: "group_id and title are required" }, { status: 400 });
  }

  const kind = body.kind === "rule" ? "rule" : "task";

  const { data: group } = await supabase
    .from("office_groups")
    .select("id")
    .eq("id", body.group_id)
    .is("deleted_at", null)
    .single();
  if (!group) {
    return NextResponse.json({ error: "group_id does not exist" }, { status: 400 });
  }

  const { data: maxRow } = await supabase
    .from("office_tasks")
    .select("sort")
    .eq("group_id", body.group_id)
    .is("deleted_at", null)
    .order("sort", { ascending: false })
    .limit(1)
    .maybeSingle();

  const nextSort = (maxRow?.sort ?? -SORT_STEP) + SORT_STEP;

  // Rule cards never carry assignees; task cards auto-assign the
  // creator unless assignee_ids was explicitly supplied.
  const assigneeIds = kind === "rule" ? [] : body.assignee_ids === undefined ? [user.id] : body.assignee_ids;

  const { data: task, error } = await supabase
    .from("office_tasks")
    .insert({
      group_id: body.group_id,
      title: body.title.trim(),
      description: body.description?.trim() || null,
      kind,
      due_date: kind === "rule" ? null : body.due_date || null,
      sort: nextSort,
      created_by: user.id,
    })
    .select()
    .single();

  if (error) {
    const status = error.code === "23503" ? 400 : 500;
    return NextResponse.json({ error: error.message }, { status });
  }

  let assignees: OfficeAssigneeSummary[] = [];
  if (assigneeIds.length > 0) {
    const { error: assigneeError } = await supabase
      .from("office_task_assignees")
      .insert(assigneeIds.map((profileId) => ({ task_id: task.id, profile_id: profileId })));
    if (!assigneeError) {
      const { data: profiles } = await supabase
        .from("profiles")
        .select("id,full_name")
        .in("id", assigneeIds);
      assignees = profiles ?? [];
    }
  }

  const taskWithRefs: OfficeTaskWithRefs = { ...task, assignees, subtasks: [] };
  return NextResponse.json({ task: taskWithRefs }, { status: 201 });
}
