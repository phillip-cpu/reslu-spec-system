import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { Header } from "@/components/layout/Header";
import { ProjectTabs } from "@/components/projects/ProjectTabs";
import { ProjectBoard } from "@/components/board/ProjectBoard";
import { portalUrlFor } from "@/lib/portal-link";
import { DEFAULT_STATUS_COLUMNS_V3 } from "@/lib/board-constants";
import type { AssigneeSummary } from "@/types/phase-12a-b";
import type { LinkedVisitSummary } from "@/types/board-cockpit";
import type { BoardColumnV3, BoardGroupV3, BoardTaskV3 } from "@/types/board-v3";

// Board v3 — Monday parity round: REPLACES the Board v2 Waiting-first
// seed with the Monday-parity status vocabulary
// (lib/board-constants.ts's DEFAULT_STATUS_COLUMNS_V3 — Not Booked/
// Booked/In Progress/Done). Only used when a project currently has
// ZERO columns (first-ever visit) — same gating as before this round;
// see app/api/projects/[id]/board/route.ts's own doc comment for why
// existing (already-seeded) boards are never migrated/touched.
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
    const seedRows = DEFAULT_STATUS_COLUMNS_V3.map((name, i) => ({
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

  // Round A "Board owns dates, Timeline is the visual" — mirrors GET
  // /api/projects/[id]/board's own lightweight second query (see that
  // route's doc comment): every group with a linked phase (phase_id
  // set) needs that phase's own start_date/end_date so the Grouped-
  // list header can render its compact date inputs on first paint,
  // not just after a client refetch.
  const linkedPhaseIds = [...new Set((groups ?? []).map((g) => g.phase_id).filter(Boolean))] as string[];
  const { data: linkedPhases } = linkedPhaseIds.length
    ? await supabase
        .from("schedule_phases")
        .select("id,start_date,end_date")
        .in("id", linkedPhaseIds)
        .is("deleted_at", null)
    : { data: [] as { id: string; start_date: string; end_date: string }[] };
  const phaseDatesById = new Map((linkedPhases ?? []).map((p) => [p.id, p]));

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
  // Board cockpit round (migration 029) — same batched visit join GET
  // /api/projects/[id]/board's own handler does, mirrored here so first
  // paint already shows each card's live booking status badge.
  const visitIds = [...new Set(taskRows.map((t) => t.visit_id).filter(Boolean))] as string[];

  const [{ data: assigneeLinks }, { data: contacts }, { data: visits }] = await Promise.all([
    taskIds.length
      ? supabase.from("board_task_assignees").select("task_id,profile_id").in("task_id", taskIds)
      : Promise.resolve({ data: [] as { task_id: string; profile_id: string }[] }),
    contactIds.length
      ? supabase.from("contacts").select("id,company,contact_name").in("id", contactIds)
      : Promise.resolve({ data: [] as { id: string; company: string; contact_name: string | null }[] }),
    visitIds.length
      ? supabase.from("trade_visits").select("id,status,start_date,end_date,contact_id").in("id", visitIds)
      : Promise.resolve({ data: [] as { id: string; status: string; start_date: string; end_date: string; contact_id: string | null }[] }),
  ]);

  const teamById = new Map((team ?? []).map((p) => [p.id, p]));
  const contactById = new Map((contacts ?? []).map((c) => [c.id, c]));
  const visitById = new Map((visits ?? []).map((v) => [v.id, v]));

  const assigneesByTask = new Map<string, AssigneeSummary[]>();
  for (const link of assigneeLinks ?? []) {
    const profile = teamById.get(link.profile_id);
    if (!profile) continue;
    const list = assigneesByTask.get(link.task_id) ?? [];
    list.push(profile);
    assigneesByTask.set(link.task_id, list);
  }

  const tasksWithRefs: BoardTaskV3[] = taskRows.map((t) => {
    const linkedVisit = t.visit_id ? visitById.get(t.visit_id) : undefined;
    const visitSummary: LinkedVisitSummary | null = linkedVisit
      ? {
          id: linkedVisit.id,
          status: linkedVisit.status as LinkedVisitSummary["status"],
          start_date: linkedVisit.start_date,
          end_date: linkedVisit.end_date,
          contact: linkedVisit.contact_id ? contactById.get(linkedVisit.contact_id) ?? null : null,
        }
      : null;
    return {
      ...t,
      assignees: assigneesByTask.get(t.id) ?? [],
      contact: t.contact_id ? contactById.get(t.contact_id) ?? null : null,
      visit: visitSummary,
    };
  });

  const tasksByColumn = new Map<string, BoardTaskV3[]>();
  const tasksByGroup = new Map<string, BoardTaskV3[]>();
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

  const initialColumns: BoardColumnV3[] = columns.map((c) => ({
    ...c,
    tasks: tasksByColumn.get(c.id) ?? [],
  }));

  const initialGroups: BoardGroupV3[] = (groups ?? []).map((g) => {
    const linkedPhase = g.phase_id ? phaseDatesById.get(g.phase_id) : undefined;
    return {
      ...g,
      tasks: tasksByGroup.get(g.id) ?? [],
      phase_start_date: linkedPhase?.start_date ?? null,
      phase_end_date: linkedPhase?.end_date ?? null,
    };
  });

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
