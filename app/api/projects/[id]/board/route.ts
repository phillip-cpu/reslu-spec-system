import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { AssigneeSummary, CreateBoardTaskInputV2 } from "@/types/phase-12a-b";
import type { BoardTaskKind } from "@/types/board-cockpit";
import { DEFAULT_STATUS_COLUMNS_V3 } from "@/lib/board-constants";

/** POST body — Phase 12a-B's CreateBoardTaskInputV2 plus this round's optional `kind` (milestone toggle at creation time). Intersection type rather than editing that interface directly, per this file's own edit-boundary discipline (types/phase-12a-b.ts is a prior, already-completed round's own file). */
type CreateBoardTaskInputCockpit = CreateBoardTaskInputV2 & { kind?: BoardTaskKind };
import type { LinkedVisitSummary } from "@/types/board-cockpit";
import type { BoardColumnV3, BoardGroupV3, BoardTaskV3, BoardV3Response } from "@/types/board-v3";
/** Board v3 — Monday parity round: this route's POST body ALSO accepts an optional `parent_task_id` (sub-items, migration 031) — see this file's POST handler doc comment for validation + inheritance rules, and types/board-v3.ts's CreateSubTaskInputV3 for the documented shape. Layered as a second intersection rather than editing CreateBoardTaskInputV2 directly, same edit-boundary discipline as the `kind` addition above. */
type CreateBoardTaskInputV3 = CreateBoardTaskInputCockpit & { parent_task_id?: string | null };

/**
 * Board v2 (BUILD-SPEC.md §"Board v2"). This route supersedes the
 * Week-9 shape (single `assignee_id`, columns-only response) with:
 *   1. Multi-assignee via board_task_assignees (migration 020) —
 *      every task now carries `assignees: AssigneeSummary[]` instead of
 *      a single `assignee`. board_tasks.assignee_id is READ-ONLY here
 *      going forward (see migration 020's deprecation comment) — this
 *      route never writes it.
 *   2. Column seed order/vocabulary for BRAND NEW boards only — Board
 *      v3 — Monday parity round REPLACES the Board v2 Waiting-first
 *      seed (Waiting/To Do/In Progress/Done) with the Monday-parity
 *      status vocabulary (lib/board-constants.ts's
 *      DEFAULT_STATUS_COLUMNS_V3 — Not Booked/Booked/In Progress/Done,
 *      in that exact order), used ONLY the FIRST time this route runs
 *      for a project with zero existing board_columns rows. Existing
 *      (already-seeded, from either the original Week-9 four columns
 *      or the Board v2 Waiting-first reorder) boards are NEVER
 *      migrated/touched by this change — same "only the FIRST-EVER
 *      seed uses the new list, existing boards keep whatever they
 *      already have and stay fully renamable" discipline this route
 *      already followed for the Board v2 reorder before this round.
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
 *   4. Round A "Board owns dates, Timeline is the visual": every group
 *      with a non-null `phase_id` now ALSO carries `phase_start_date`/
 *      `phase_end_date` — a lightweight second query against
 *      schedule_phases (id, start_date, end_date only — no reason to
 *      pull the whole row) keyed by the groups' phase_id set, merged in
 *      below. This lets the Grouped-list view render compact date
 *      inputs directly on a phase-linked group header (PATCHing
 *      /api/phases/[id], the exact same route Timeline's edit panel
 *      already uses) without a second page-load round-trip. Groups
 *      with phase_id = null (unreconciled/legacy groups) simply get
 *      both fields as null — the client only renders the inputs when
 *      phase_id is present, per this round's brief.
 *
 * Response shape: BoardV2Response — { columns, groups, team }. `team`
 * is every non-deleted task's superset of possible assignees is NOT
 * what this carries; it's the project's team roster (same
 * profiles.full_name projection the Week-9 page already fetched
 * separately) so the picker UI has it without a second round-trip.
 */
// Board v3 — Monday parity round: REPLACES the prior Board v2 default
// seed list (Waiting/To Do/In Progress/Done) with the Monday-parity
// status vocabulary (lib/board-constants.ts's DEFAULT_STATUS_COLUMNS_V3
// — Not Booked/Booked/In Progress/Done) for brand-new boards ONLY —
// same "only used when this project currently has zero board_columns
// rows" gating this constant already had before this round (see the
// `if (!columns || columns.length === 0)` branch below, unchanged).
// Existing (already-seeded) boards are NEVER touched/migrated by this
// change — they keep whatever columns they already have, fully
// renamable exactly as before.
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
    const seedRows = DEFAULT_STATUS_COLUMNS_V3.map((name, i) => ({
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

  // Round A — fetch the linked phases' dates for every group that has
  // one (phase_id set), a single extra query keyed by that id set
  // rather than a per-group round-trip.
  const linkedPhaseIds = [...new Set((groups ?? []).map((g) => g.phase_id).filter(Boolean))] as string[];
  const { data: linkedPhases } = linkedPhaseIds.length
    ? await supabase
        .from("schedule_phases")
        .select("id,start_date,end_date")
        .in("id", linkedPhaseIds)
        .is("deleted_at", null)
    : { data: [] as { id: string; start_date: string; end_date: string }[] };
  const phaseDatesById = new Map((linkedPhases ?? []).map((p) => [p.id, p]));

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
  // Board cockpit round (migration 029) — batch-fetch the linked
  // trade_visits rows for every card that has one, so the card's live
  // status badge renders from this same single board fetch (no N+1 per
  // card, same batching discipline as the assignee/contact fetches
  // right below).
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

  const columnsResult: BoardColumnV3[] = columns.map((c) => ({
    ...c,
    tasks: tasksByColumn.get(c.id) ?? [],
  }));

  const groupsResult: BoardGroupV3[] = (groups ?? []).map((g) => {
    const linkedPhase = g.phase_id ? phaseDatesById.get(g.phase_id) : undefined;
    return {
      ...g,
      tasks: tasksByGroup.get(g.id) ?? [],
      phase_start_date: linkedPhase?.start_date ?? null,
      phase_end_date: linkedPhase?.end_date ?? null,
    };
  });

  const body: BoardV3Response = {
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
 * phase_group_id? } — Board v3 — Monday parity round additionally
 * accepts an optional `parent_task_id` (sub-items, migration 031's
 * board_tasks.parent_task_id): when present, (1) the referenced task
 * must belong to this project and (2) must NOT itself already have a
 * parent_task_id — an attempt to nest a sub-item under another
 * sub-item (depth 2) is rejected with HTTP 400 ("Cannot create a
 * sub-item of a sub-item..."), enforcing BUILD-SPEC.md's "one level
 * only" rule at the app layer (see migration 031's own comment for why
 * this is app-enforced, not a DB constraint). When `phase_group_id` is
 * OMITTED alongside a `parent_task_id`, the sub-item inherits the
 * PARENT's phase_group_id automatically (BUILD-SPEC.md "Sub-items
 * inherit phase_group from parent") — passing phase_group_id
 * explicitly (including `null`) still overrides that inheritance. A
 * sub-item's `sort` scope is its own sibling set (every task sharing
 * the same parent_task_id) rather than the whole column, so drag
 * reorder among sub-items never interacts with top-level task order.
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

  let body: CreateBoardTaskInputV3;
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
  if (body.kind && body.kind !== "task" && body.kind !== "milestone") {
    return NextResponse.json({ error: "kind must be 'task' or 'milestone'" }, { status: 400 });
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

  // Board v3 — Monday parity round: sub-items (migration 031's
  // parent_task_id). Resolved BEFORE the phase_group_id check below,
  // since a sub-item that omits phase_group_id in its own body
  // inherits the PARENT's phase_group_id (BUILD-SPEC.md "Sub-items
  // inherit phase_group from parent") — `effectivePhaseGroupId` is
  // what actually gets validated/inserted from this point on, not the
  // raw `body.phase_group_id`.
  let effectivePhaseGroupId = body.phase_group_id ?? null;
  if (body.parent_task_id) {
    const { data: parentTask } = await supabase
      .from("board_tasks")
      .select("id,project_id,parent_task_id,phase_group_id")
      .eq("id", body.parent_task_id)
      .eq("project_id", projectId)
      .is("deleted_at", null)
      .maybeSingle();
    if (!parentTask) {
      return NextResponse.json(
        { error: "parent_task_id does not belong to this project" },
        { status: 400 }
      );
    }
    // THE DEPTH GUARD: one level of nesting only. If the referenced
    // "parent" itself already has a non-null parent_task_id, this
    // would create a depth-2 grandchild — reject outright rather than
    // silently flattening it or allowing an ever-deepening chain.
    if (parentTask.parent_task_id) {
      return NextResponse.json(
        { error: "Cannot create a sub-item of a sub-item — only one level of nesting is supported" },
        { status: 400 }
      );
    }
    if (body.phase_group_id === undefined) {
      effectivePhaseGroupId = parentTask.phase_group_id;
    }
  }

  if (effectivePhaseGroupId) {
    const { data: group } = await supabase
      .from("board_groups")
      .select("id")
      .eq("id", effectivePhaseGroupId)
      .eq("project_id", projectId)
      .single();
    if (!group) {
      return NextResponse.json(
        { error: "phase_group_id does not belong to this project" },
        { status: 400 }
      );
    }
  }

  // Board v3 — Monday parity round: a sub-item's sort scope is its OWN
  // sibling set (every other task sharing the same parent_task_id),
  // NEVER the whole column — BUILD-SPEC.md "Reorder: sub-items only
  // reorder within their own sibling set (same parent_task_id), never
  // across parents or up to top level." A top-level task (no
  // parent_task_id) keeps the original "max sort within this column"
  // scope, unchanged from before this round.
  const { data: maxRow } = body.parent_task_id
    ? await supabase
        .from("board_tasks")
        .select("sort")
        .eq("parent_task_id", body.parent_task_id)
        .is("deleted_at", null)
        .order("sort", { ascending: false })
        .limit(1)
        .maybeSingle()
    : await supabase
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
      phase_group_id: effectivePhaseGroupId || null,
      parent_task_id: body.parent_task_id || null,
      kind: body.kind || "task",
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
