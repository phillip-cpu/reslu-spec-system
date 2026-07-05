import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { Header } from "@/components/layout/Header";
import { ProjectTabs } from "@/components/projects/ProjectTabs";
import { ProjectBoard } from "@/components/board/ProjectBoard";
import { portalUrlFor } from "@/lib/portal-link";
import type {
  AssigneeSummary,
  BoardColumnWithAssigneeTasks,
  BoardGroupWithTasks,
  BoardTaskWithAssignees,
} from "@/types/phase-12a-b";

// Board v2 — BUILD-SPEC.md "Board v2" point 2: "'Waiting' becomes the
// FIRST default column ... for new boards." Only used when a project
// currently has ZERO columns (first-ever visit) — see this file's own
// doc comment on the GET route (app/api/projects/[id]/board/route.ts)
// for why the "existing boards get a one-time reorder only if
// untouched" half of that spec sentence is deliberately NOT automated
// here.
const DEFAULT_COLUMNS_V2 = ["Waiting", "To Do", "In Progress", "Done"];
const SORT_STEP = 1000;

/**
 * /projects/[id]/board — Board v2 (BUILD-SPEC.md "Board v2"). Team-
 * visible, not admin-gated. Follows this codebase's established
 * sub-page convention (documents/estimate/invoices/overview all query
 * Supabase directly server-side rather than fetching their own API
 * route) — column/group seeding logic is duplicated here in the same
 * small, idempotent shape as the API route keeps for non-page callers
 * (Aria, the client-side refresh after a mutation).
 *
 * Phase groups (board_groups) are DELIBERATELY NOT seeded here on
 * first page load — only on first visit to the Grouped list view
 * client-side (POST .../board/groups/seed, triggered by
 * components/board/ProjectBoard.tsx's view toggle) — see that route's
 * doc comment for why a Kanban-only team should never accumulate empty
 * group rows.
 */
export default async function ProjectBoardPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const [{ data: project }, info, { data: userData }, { data: team }] = await Promise.all([
    supabase.from("projects").select("id, name, client_name, client_token").eq("id", id).single(),
    getUserRole(supabase),
    supabase.auth.getUser(),
    supabase.from("profiles").select("id, full_name").order("full_name"),
  ]);

  if (!project) {
    notFound();
  }
  const isAdmin = info?.role === "admin";
  const currentUserId = userData.user?.id ?? "";

  let { data: columns } = await supabase
    .from("board_columns")
    .select("*")
    .eq("project_id", id)
    .order("sort", { ascending: true });

  if (!columns || columns.length === 0) {
    const seedRows = DEFAULT_COLUMNS_V2.map((name, i) => ({
      project_id: id,
      name,
      sort: i * SORT_STEP,
    }));
    const { data: seeded } = await supabase.from("board_columns").insert(seedRows).select();
    columns = seeded ?? [];
  }

  const { data: groups } = await supabase
    .from("board_groups")
    .select("*")
    .eq("project_id", id)
    .order("sort", { ascending: true });

  const columnIds = columns.map((c) => c.id);
  const { data: tasks } = columnIds.length
    ? await supabase
        .from("board_tasks")
        .select("*")
        .in("column_id", columnIds)
        .is("deleted_at", null)
        .order("sort", { ascending: true })
    : { data: [] };

  const taskRows = tasks ?? [];
  const taskIds = taskRows.map((t) => t.id);
  const contactIds = [...new Set(taskRows.map((t) => t.contact_id).filter(Boolean))] as string[];

  const [{ data: assigneeLinks }, { data: contacts }] = await Promise.all([
    taskIds.length
      ? supabase.from("board_task_assignees").select("task_id,profile_id").in("task_id", taskIds)
      : Promise.resolve({ data: [] as { task_id: string; profile_id: string }[] }),
    contactIds.length
      ? supabase.from("contacts").select("id,company,contact_name").in("id", contactIds)
      : Promise.resolve({ data: [] as { id: string; company: string; contact_name: string | null }[] }),
  ]);

  const teamById = new Map((team ?? []).map((p) => [p.id, p]));
  const contactById = new Map((contacts ?? []).map((c) => [c.id, c]));

  const assigneesByTask = new Map<string, AssigneeSummary[]>();
  for (const link of assigneeLinks ?? []) {
    const profile = teamById.get(link.profile_id);
    if (!profile) continue;
    const list = assigneesByTask.get(link.task_id) ?? [];
    list.push(profile);
    assigneesByTask.set(link.task_id, list);
  }

  const tasksWithRefs: BoardTaskWithAssignees[] = taskRows.map((t) => ({
    ...t,
    assignees: assigneesByTask.get(t.id) ?? [],
    contact: t.contact_id ? contactById.get(t.contact_id) ?? null : null,
  }));

  const tasksByColumn = new Map<string, BoardTaskWithAssignees[]>();
  const tasksByGroup = new Map<string, BoardTaskWithAssignees[]>();
  for (const t of tasksWithRefs) {
    const colList = tasksByColumn.get(t.column_id) ?? [];
    colList.push(t);
    tasksByColumn.set(t.column_id, colList);
    if (t.phase_group_id) {
      const groupList = tasksByGroup.get(t.phase_group_id) ?? [];
      groupList.push(t);
      tasksByGroup.set(t.phase_group_id, groupList);
    }
  }

  const initialColumns: BoardColumnWithAssigneeTasks[] = columns.map((c) => ({
    ...c,
    tasks: tasksByColumn.get(c.id) ?? [],
  }));

  const initialGroups: BoardGroupWithTasks[] = (groups ?? []).map((g) => ({
    ...g,
    tasks: tasksByGroup.get(g.id) ?? [],
  }));

  return (
    <>
      <Header title={project.name} subtitle={`${project.client_name} · Board`} titleHref={`/projects/${id}`} />
      <ProjectTabs projectId={id} active="board" isAdmin={isAdmin} portalUrl={portalUrlFor(project.client_token)} />
      <main className="flex-1 px-8 py-8">
        <ProjectBoard
          projectId={id}
          initialColumns={initialColumns}
          initialGroups={initialGroups}
          team={team ?? []}
          currentUserId={currentUserId}
        />
      </main>
    </>
  );
}
