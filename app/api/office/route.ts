import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type {
  OfficeAssigneeSummary,
  OfficeBoardResponse,
  OfficeGroupWithTasks,
  OfficeSubtask,
  OfficeTaskWithRefs,
  OfficeTeamMember,
} from "@/types/phase-13";

export const runtime = "nodejs";

/**
 * GET /api/office
 * Phase 13 — Office board (BUILD-SPEC.md §"13 Office", docs/OFFICE-BRIEF.md).
 * Global board, not per-project — every signed-in team member sees the
 * same single board (including Phillip's personal "Phillip" group,
 * which is just another department group on this shared board, per
 * OFFICE-BRIEF.md: "it's his queue on a shared board" — no special
 * gating). Returns every non-deleted group with its non-deleted tasks
 * nested (each task carrying its assignees + subtasks), plus the team
 * roster for assignee pickers — one fetch renders the whole page, same
 * shape as GET /api/projects/[id]/board (Board v2).
 */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: groups } = await supabase
    .from("office_groups")
    .select("*")
    .is("deleted_at", null)
    .order("sort", { ascending: true });

  // `email` is included alongside id/full_name (beyond what the board
  // UI itself needs) so the create_office_task MCP tool can resolve an
  // `assignee_email` argument to a profile id from this same response
  // — this codebase has no standalone GET /api/profiles listing route.
  // See types/phase-13.ts's OfficeTeamMember doc comment.
  const { data: team } = await supabase.from("profiles").select("id,full_name,email").order("full_name");

  const groupIds = (groups ?? []).map((g) => g.id);
  const { data: tasks } = groupIds.length
    ? await supabase
        .from("office_tasks")
        .select("*")
        .in("group_id", groupIds)
        .is("deleted_at", null)
        .order("sort", { ascending: true })
    : { data: [] };

  const taskRows = tasks ?? [];
  const taskIds = taskRows.map((t) => t.id);

  const [{ data: assigneeLinks }, { data: subtasks }] = await Promise.all([
    taskIds.length
      ? supabase.from("office_task_assignees").select("task_id,profile_id").in("task_id", taskIds)
      : Promise.resolve({ data: [] as { task_id: string; profile_id: string }[] }),
    taskIds.length
      ? supabase
          .from("office_subtasks")
          .select("*")
          .in("task_id", taskIds)
          .order("sort", { ascending: true })
      : Promise.resolve({ data: [] as OfficeSubtask[] }),
  ]);

  const teamById = new Map((team ?? []).map((p) => [p.id, p]));

  const assigneesByTask = new Map<string, OfficeAssigneeSummary[]>();
  for (const link of assigneeLinks ?? []) {
    const profile = teamById.get(link.profile_id);
    if (!profile) continue;
    const list = assigneesByTask.get(link.task_id) ?? [];
    list.push(profile);
    assigneesByTask.set(link.task_id, list);
  }

  const subtasksByTask = new Map<string, OfficeSubtask[]>();
  for (const s of subtasks ?? []) {
    const list = subtasksByTask.get(s.task_id) ?? [];
    list.push(s);
    subtasksByTask.set(s.task_id, list);
  }

  const tasksWithRefs: OfficeTaskWithRefs[] = taskRows.map((t) => ({
    ...t,
    assignees: assigneesByTask.get(t.id) ?? [],
    subtasks: subtasksByTask.get(t.id) ?? [],
  }));

  const tasksByGroup = new Map<string, OfficeTaskWithRefs[]>();
  for (const t of tasksWithRefs) {
    const list = tasksByGroup.get(t.group_id) ?? [];
    list.push(t);
    tasksByGroup.set(t.group_id, list);
  }

  const groupsResult: OfficeGroupWithTasks[] = (groups ?? []).map((g) => ({
    ...g,
    tasks: tasksByGroup.get(g.id) ?? [],
  }));

  const body: OfficeBoardResponse = {
    groups: groupsResult,
    team: team ?? [],
  };
  return NextResponse.json(body);
}
