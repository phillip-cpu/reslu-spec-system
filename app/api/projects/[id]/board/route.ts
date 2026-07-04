import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type {
  BoardColumnWithTasks,
  BoardResponse,
  BoardTaskWithRefs,
  CreateBoardTaskInput,
} from "@/types";

/** Default columns seeded per project on first visit — BUILD-SPEC.md "Project board". */
const DEFAULT_COLUMNS = ["To Do", "In Progress", "Waiting", "Done"];

/** Gap between sibling sort values — see migration 013's comment on board_tasks.sort. */
const SORT_STEP = 1000;

/**
 * GET /api/projects/[id]/board
 * Team-visible (task/scheduling data, not financial). Seeds the
 * project's default columns idempotently on first visit (only if the
 * project currently has zero columns) — BUILD-SPEC.md "board_columns
 * ... seeded per project on first visit with To Do / In Progress /
 * Waiting / Done". Response: { columns: BoardColumnWithTasks[] },
 * columns sorted, each with its non-deleted tasks sorted, each task
 * annotated with lightweight assignee/contact display data (a single
 * profile+contact lookup batched across all tasks, not N+1). Aria-relevant.
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

  let { data: columns } = await supabase
    .from("board_columns")
    .select("*")
    .eq("project_id", projectId)
    .order("sort", { ascending: true });

  if (!columns || columns.length === 0) {
    const seedRows = DEFAULT_COLUMNS.map((name, i) => ({
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

  const columnIds = columns.map((c) => c.id);
  const { data: tasks } = columnIds.length
    ? await supabase
        .from("board_tasks")
        .select("*")
        .in("column_id", columnIds)
        .is("deleted_at", null)
        .order("sort", { ascending: true })
    : { data: [] };

  const assigneeIds = [...new Set((tasks ?? []).map((t) => t.assignee_id).filter(Boolean))] as string[];
  const contactIds = [...new Set((tasks ?? []).map((t) => t.contact_id).filter(Boolean))] as string[];

  const [{ data: profiles }, { data: contacts }] = await Promise.all([
    assigneeIds.length
      ? supabase.from("profiles").select("id,full_name").in("id", assigneeIds)
      : Promise.resolve({ data: [] as { id: string; full_name: string }[] }),
    contactIds.length
      ? supabase.from("contacts").select("id,company,contact_name").in("id", contactIds)
      : Promise.resolve({ data: [] as { id: string; company: string; contact_name: string | null }[] }),
  ]);

  const profileById = new Map((profiles ?? []).map((p) => [p.id, p]));
  const contactById = new Map((contacts ?? []).map((c) => [c.id, c]));

  const tasksByColumn = new Map<string, BoardTaskWithRefs[]>();
  for (const t of tasks ?? []) {
    const withRefs: BoardTaskWithRefs = {
      ...t,
      assignee: t.assignee_id ? profileById.get(t.assignee_id) ?? null : null,
      contact: t.contact_id ? contactById.get(t.contact_id) ?? null : null,
    };
    const list = tasksByColumn.get(t.column_id) ?? [];
    list.push(withRefs);
    tasksByColumn.set(t.column_id, list);
  }

  const result: BoardColumnWithTasks[] = columns.map((c) => ({
    ...c,
    tasks: tasksByColumn.get(c.id) ?? [],
  }));

  const body: BoardResponse = { columns: result };
  return NextResponse.json(body);
}

/**
 * POST /api/projects/[id]/board
 * body: CreateBoardTaskInput — { column_id (required), title
 * (required), description?, assignee_id?, contact_id?, due_date? }.
 * Response: { task } (201). `sort` is server-computed as
 * max(existing sort in this column) + SORT_STEP, so new cards always
 * land at the bottom of their column — see migration 013's sort-scheme
 * comment. Aria-relevant (Aria operates boards per BUILD-SPEC.md
 * "Agent control — Aria").
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

  let body: CreateBoardTaskInput;
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

  // Validate the column belongs to this project (defence against a
  // forged/cross-project column_id — same "verify ownership" spirit as
  // the portal token check, applied here to a team-side write).
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

  const { data: maxRow } = await supabase
    .from("board_tasks")
    .select("sort")
    .eq("column_id", body.column_id)
    .is("deleted_at", null)
    .order("sort", { ascending: false })
    .limit(1)
    .maybeSingle();

  const nextSort = (maxRow?.sort ?? -SORT_STEP) + SORT_STEP;

  const { data: task, error } = await supabase
    .from("board_tasks")
    .insert({
      project_id: projectId,
      column_id: body.column_id,
      title: body.title.trim(),
      description: body.description?.trim() || null,
      assignee_id: body.assignee_id || null,
      contact_id: body.contact_id || null,
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

  return NextResponse.json({ task }, { status: 201 });
}
