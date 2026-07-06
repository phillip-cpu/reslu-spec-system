import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type {
  AssigneeSummary,
  BoardColumnWithAssigneeTasks,
  BoardGroupWithTasks,
  BoardV2Response,
  BoardTaskWithAssignees,
  CreateBoardTaskInputV2,
} from "@/types/phase-12a-b";

/**
 * Board v2 (BUILD-SPEC.md §"Board v2"). This route supersedes the
 * Week-9 shape (single `assignee_id`, columns-only response) with:
 *   1. Multi-assignee via board_task_assignees (migration 020) —
 *      every task now carries `assignees: AssigneeSummary[]` instead of
 *      a single `assignee`. board_tasks.assignee_id is READ-ONLY here
 *      going forward (see migration 020's deprecation comment) — this
 *      route never writes it.
 *   2. Column seed order flips to Waiting-first for BRAND NEW boards
 *      only (DEFAULT_COLUMNS_V2) — BUILD-SPEC.md "Board v2" point 2:
 *      "'Waiting' becomes the FIRST default column ... for new boards.
 *      Existing boards get a one-time reorder only if untouched."  The
 *      "untouched" one-time reorder is intentionally NOT performed by
 *      this route (a silent server-side reorder of a board a team
 *      member may already be relying on the visual order of is a
 *      surprising side effect for a GET) — see this task's final
 *      report for the one-time migration note; only the FIRST-EVER
 *      seed (zero existing columns) uses the new order, which is the
 *      unambiguous, safe half of that spec sentence to automate.
 *   3. Phase groups (board_groups, seeded from the shared, editable
 *      phase_template — see lib/phase-seed.ts's
 *      seedPhaseTemplateIfEmpty() — on first visit to EITHER the
 *      Timeline tab or the Grouped list view specifically, per Fix
 *      Round A's "shared seed path" unification; triggered here via
 *      POST .../board/groups/seed) are returned alongside columns so
 *      the client can render either view from one fetch. Fix Round A
 *      additionally: every group now carries `phase_id` (BoardGroup's
 *      own field, types/phase-12a-b.ts) since it's included by this
 *      route's existing `select("*")` — no query change needed here.
 *
 * Response shape: BoardV2Response — { columns, groups, team }. `team`
 * is every non-deleted task's superset of possible assignees is NOT
 * what this carries; it's the project's team roster (same
 * profiles.full_name projection the Week-9 page already fetched
 * separately) so the picker UI has it without a second round-trip.
 */
const DEFAULT_COLUMNS_V2 = ["Waiting", "To Do", "In Progress", "Done"];
const SORT_STEP = 1000;

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

  let { data: columns } = await supabase
    .from("board_columns")
    .select("*")
    .eq("project_id", projectId)
    .order("sort", { ascending: true });

  if (!columns || columns.length === 0) {
    const seedRows = DEFAULT_COLUMNS_V2.map((name, i) => ({
      project_id: projectId,
      name,
      sort: i * SORT_STEP,
    }));
    const { data: seeded, error: seedError } = await supabase
      .from("board_columns")
      .insert(seedRows)
      .select();
    if (seedError) {
      return NextResponse.json({ error: seedError.message }, { status: 500 });
    }
    columns = seeded ?? [];
  }

  const { data: groups } = await supabase
    .from("board_groups")
    .select("*")
    .eq("project_id", projectId)
    .order("sort", { ascending: true });

  const { data: team } = await supabase.from("profiles").select("id,full_name").order("full_name");

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

  const columnsResult: BoardColumnWithAssigneeTasks[] = columns.map((c) => ({
    ...c,
    tasks: tasksByColumn.get(c.id) ?? [],
  }));

  const groupsResult: BoardGroupWithTasks[] = (groups ?? []).map((g) => ({
    ...g,
    tasks: tasksByGroup.get(g.id) ?? [],
  }));

  const body: BoardV2Response = {
    columns: columnsResult,
    groups: groupsResult,
    team: team ?? [],
  };
  return NextResponse.json(body);
}

/**
 * POST /api/projects/[id]/board
 * body: CreateBoardTaskInputV2 — { column_id (required), title
 * (required), description?, assignee_ids?, contact_id?, due_date?,
 * phase_group_id? }.
 *
 * Auto-assign on create (BUILD-SPEC.md "Board v2" point 1): when
 * `assignee_ids` is OMITTED entirely, the creator is assigned
 * automatically. Passing an explicit array (including `[]`) overrides
 * this — `[]` means "no assignees", any populated array means "assign
 * exactly these people" (the creator is NOT auto-added on top of an
 * explicit list — "overridable" per the spec means the override wins
 * outright, not that it merges with the auto-assign).
 *
 * board_tasks.assignee_id (the deprecated single-assignee column) is
 * also written here, set to the FIRST resolved assignee (or null) —
 * purely for backward-compatible reads of that column elsewhere in the
 * codebase (e.g. any historical report querying it directly); every
 * new UI reads/writes exclusively through board_task_assignees.
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

  let body: CreateBoardTaskInputV2;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.column_id || !body.title?.trim()) {
    return NextResponse.json(
      { error: "column_id and title are required" },
      { status: 400 }
    );
  }

  const { data: column } = await supabase
    .from("board_columns")
    .select("id,project_id")
    .eq("id", body.column_id)
    .eq("project_id", projectId)
    .single();
  if (!column) {
    return NextResponse.json(
      { error: "column_id does not belong to this project" },
      { status: 400 }
    );
  }

  if (body.phase_group_id) {
    const { data: group } = await supabase
      .from("board_groups")
      .select("id")
      .eq("id", body.phase_group_id)
      .eq("project_id", projectId)
      .single();
    if (!group) {
      return NextResponse.json(
        { error: "phase_group_id does not belong to this project" },
        { status: 400 }
      );
    }
  }

  const { data: maxRow } = await supabase
    .from("board_tasks")
    .select("sort")
    .eq("column_id", body.column_id)
    .is("deleted_at", null)
    .order("sort", { ascending: false })
    .limit(1)
    .maybeSingle();

  const nextSort = (maxRow?.sort ?? -SORT_STEP) + SORT_STEP;

  // Auto-assign on create — omitted assignee_ids means "just me".
  const assigneeIds = body.assignee_ids === undefined ? [user.id] : body.assignee_ids;

  const { data: task, error } = await supabase
    .from("board_tasks")
    .insert({
      project_id: projectId,
      column_id: body.column_id,
      title: body.title.trim(),
      description: body.description?.trim() || null,
      assignee_id: assigneeIds[0] ?? null,
      contact_id: body.contact_id || null,
      due_date: body.due_date || null,
      phase_group_id: body.phase_group_id || null,
      sort: nextSort,
      created_by: user.id,
    })
    .select()
    .single();

  if (error) {
    const status = error.code === "23503" ? 400 : 500;
    return NextResponse.json({ error: error.message }, { status });
  }

  if (assigneeIds.length > 0) {
    const { error: assigneeError } = await supabase
      .from("board_task_assignees")
      .insert(assigneeIds.map((profileId) => ({ task_id: task.id, profile_id: profileId })));
    if (assigneeError) {
      // The task itself was created successfully — an assignee-link
      // failure (e.g. a bogus profile id slipping past validation)
      // shouldn't roll back card creation; report it but still return
      // the created task so the caller isn't left thinking nothing
      // happened.
      return NextResponse.json(
        { task, warning: `Card created, but could not assign: ${assigneeError.message}` },
        { status: 201 }
      );
    }
  }

  return NextResponse.json({ task }, { status: 201 });
}
