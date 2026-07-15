import { createClient } from "@/lib/supabase/server";
import { Header } from "@/components/layout/Header";
import { OfficeBoard } from "@/components/office/OfficeBoard";
import { FollowupApprovalInbox } from "@/components/office/FollowupApprovalInbox";
import type { OfficeGroupWithTasks, OfficeTaskWithRefs, OfficeAssigneeSummary, OfficeSubtask } from "@/types/phase-13";
import type { AriaFollowupDraft } from "@/types/aria-followups";

/**
 * /office — Phase 13 Office board (BUILD-SPEC.md §"13 Office",
 * docs/OFFICE-BRIEF.md). Global board, not per-project — sidebar entry
 * placed right after My Work, before Search (see
 * components/layout/Sidebar.tsx's own comment). Team-visible, no admin
 * gating (none of this data is financial, and the "Phillip" department
 * group is visible to everyone per the brief's "it's his queue on a
 * shared board" framing).
 *
 * Data is fetched server-side here (same pattern as LibraryPage) so the
 * first paint has content; OfficeBoard itself owns all subsequent
 * client-side mutation (add/complete/move/etc.) via the /api/office*
 * routes, same split as ProjectBoard/BoardV2Response.
 */
export default async function OfficePage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: groups } = await supabase
    .from("office_groups")
    .select("*")
    .is("deleted_at", null)
    .order("sort", { ascending: true });

  const { data: team } = await supabase.from("profiles").select("id,full_name").order("full_name");

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
      ? supabase.from("office_subtasks").select("*").in("task_id", taskIds).order("sort", { ascending: true })
      : Promise.resolve({ data: [] as OfficeSubtask[] }),
  ]);

  const { data: followupDrafts } = await supabase
    .from("aria_followup_drafts")
    .select("*,lead:leads(id,first_name,surname_project,stage,follow_up_date)")
    .eq("status", "pending")
    .order("created_at", { ascending: false });

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

  const groupsWithTasks: OfficeGroupWithTasks[] = (groups ?? []).map((g) => ({
    ...g,
    tasks: tasksByGroup.get(g.id) ?? [],
  }));

  return (
    <>
      <Header title="Office" subtitle="Business housekeeping — marketing, ads, ops, systems, and Phillip's queue." />
      <main className="flex-1 px-8 py-8">
        <FollowupApprovalInbox initialDrafts={(followupDrafts ?? []) as AriaFollowupDraft[]} />
        <OfficeBoard
          initialGroups={groupsWithTasks}
          team={team ?? []}
          currentUserId={user?.id ?? ""}
        />
      </main>
    </>
  );
}
