import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { DEFAULT_STATUS_COLUMNS_V3 } from "@/lib/board-constants";
import type { ConvertBriefItemInput, ConvertBriefItemResponse, DailyBriefItem } from "@/types/round-daily-brief";

export const runtime = "nodejs";

const SORT_STEP = 1000;
const OFFICE_FALLBACK_GROUP_NAME = "Phillip";

/** Adelaide-local "today" — same technique as every other date-anchor in this round (lib/time-format.ts's adelaideNowParts, lib/daily-brief-generate.ts's adelaideToday) so a conversion's default due date matches what a Phillip-side "due today" chip would show, not a UTC-shifted one. */
function adelaideToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Adelaide" }).format(new Date());
}

/**
 * POST /api/brief/items/[id]/convert
 * BUILD-SPEC.md "Daily Brief" item actions: "Add to project -> (project
 * picker -> creates a board task from the item: title, today+ due
 * default, links converted_task_id, brief item auto-ticks with 'added
 * to {project}' note inline); no project chosen -> office task in the
 * 'Phillip' group." body: ConvertBriefItemInput — { project_id?: string
 * | null }. Omit/null project_id -> the office-task fallback path.
 *
 * Idempotent guard: a brief item already carrying either
 * converted_task_id or converted_office_task_id has already been
 * converted once — this route refuses a second conversion (400) rather
 * than silently creating a second duplicate task, since "Add to
 * project ->" is a one-shot action per item (the panel itself disables
 * the action once converted_label is set — see
 * components/my-work/DailyBrief.tsx).
 *
 * Admin-gated, same as every other /api/brief* route.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (info.role !== "admin") {
    return NextResponse.json({ error: "The Daily Brief is admin-only in v1." }, { status: 403 });
  }

  const { data: briefItem } = await supabase.from("daily_brief_items").select("*").eq("id", id).single();
  if (!briefItem) {
    return NextResponse.json({ error: "Brief item not found" }, { status: 404 });
  }
  if (briefItem.converted_task_id || briefItem.converted_office_task_id) {
    return NextResponse.json({ error: "This brief item has already been added to a project/office board." }, { status: 400 });
  }

  let body: ConvertBriefItemInput;
  try {
    body = request.headers.get("content-length") === "0" ? {} : await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const today = adelaideToday();

  // ---- Path A: project chosen -> board task ----
  if (body.project_id) {
    const { data: project } = await supabase.from("projects").select("id,name,alias").eq("id", body.project_id).single();
    if (!project) {
      return NextResponse.json({ error: "project_id does not exist" }, { status: 400 });
    }

    // "project's first group/column defaults" — first board_columns row
    // by sort, seeding the standard Board v3 columns if this project's
    // board has never been opened yet (same seed list/condition GET
    // /api/projects/[id]/board itself uses for a brand-new board).
    let { data: firstColumn } = await supabase
      .from("board_columns")
      .select("id")
      .eq("project_id", body.project_id)
      .order("sort", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (!firstColumn) {
      const seedRows = DEFAULT_STATUS_COLUMNS_V3.map((name, i) => ({ project_id: body.project_id, name, sort: i * SORT_STEP }));
      const { data: seeded, error: seedError } = await supabase.from("board_columns").insert(seedRows).select().order("sort", { ascending: true });
      if (seedError || !seeded || seeded.length === 0) {
        return NextResponse.json({ error: seedError?.message ?? "Could not seed a board column for this project" }, { status: 500 });
      }
      firstColumn = seeded[0];
    }
    if (!firstColumn) {
      return NextResponse.json({ error: "Could not resolve a board column for this project" }, { status: 500 });
    }

    const { data: firstGroup } = await supabase
      .from("board_groups")
      .select("id")
      .eq("project_id", body.project_id)
      .order("sort", { ascending: true })
      .limit(1)
      .maybeSingle();

    const { data: maxRow } = await supabase
      .from("board_tasks")
      .select("sort")
      .eq("column_id", firstColumn.id)
      .is("deleted_at", null)
      .order("sort", { ascending: false })
      .limit(1)
      .maybeSingle();
    const nextSort = (maxRow?.sort ?? -SORT_STEP) + SORT_STEP;

    const { data: task, error: taskError } = await supabase
      .from("board_tasks")
      .insert({
        project_id: body.project_id,
        column_id: firstColumn.id,
        title: briefItem.title,
        due_date: today,
        phase_group_id: firstGroup?.id ?? null,
        assignee_id: info.userId,
        sort: nextSort,
        created_by: info.userId,
      })
      .select()
      .single();

    if (taskError || !task) {
      return NextResponse.json({ error: taskError?.message ?? "Could not create board task" }, { status: 500 });
    }
    await supabase.from("board_task_assignees").insert({ task_id: task.id, profile_id: info.userId });

    const { data: updatedItem, error: updateError } = await supabase
      .from("daily_brief_items")
      .update({
        converted_task_id: task.id,
        project_id: body.project_id,
        status: "done",
        acknowledged_at: new Date().toISOString(),
      })
      .eq("id", id)
      .select()
      .single();
    if (updateError || !updatedItem) {
      return NextResponse.json(
        { error: `Board task created (id ${task.id}), but the brief item could not be updated: ${updateError?.message ?? "unknown error"}` },
        { status: 500 }
      );
    }

    const body_: ConvertBriefItemResponse = {
      item: {
        ...(updatedItem as DailyBriefItem),
        project: { id: project.id, name: project.name, alias: project.alias },
        carried_over_label: null,
        converted_label: `added to ${project.name}`,
      },
      created: { kind: "board_task", id: task.id },
    };
    return NextResponse.json(body_, { status: 201 });
  }

  // ---- Path B: no project chosen -> office task, 'Phillip' group (fallback: first group) ----
  const { data: officeGroups } = await supabase
    .from("office_groups")
    .select("id,name,sort")
    .is("deleted_at", null)
    .order("sort", { ascending: true });
  const groups = officeGroups ?? [];
  const targetGroup =
    groups.find((g) => g.name.trim().toLowerCase() === OFFICE_FALLBACK_GROUP_NAME.toLowerCase()) ?? groups[0];
  if (!targetGroup) {
    return NextResponse.json({ error: "No Office groups exist — cannot convert to an office task." }, { status: 500 });
  }

  const { data: maxOfficeRow } = await supabase
    .from("office_tasks")
    .select("sort")
    .eq("group_id", targetGroup.id)
    .is("deleted_at", null)
    .order("sort", { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextOfficeSort = (maxOfficeRow?.sort ?? -SORT_STEP) + SORT_STEP;

  const { data: officeTask, error: officeTaskError } = await supabase
    .from("office_tasks")
    .insert({
      group_id: targetGroup.id,
      title: briefItem.title,
      kind: "task",
      due_date: today,
      sort: nextOfficeSort,
      created_by: info.userId,
    })
    .select()
    .single();

  if (officeTaskError || !officeTask) {
    return NextResponse.json({ error: officeTaskError?.message ?? "Could not create office task" }, { status: 500 });
  }
  await supabase.from("office_task_assignees").insert({ task_id: officeTask.id, profile_id: info.userId });

  const { data: updatedItem2, error: updateError2 } = await supabase
    .from("daily_brief_items")
    .update({
      converted_office_task_id: officeTask.id,
      status: "done",
      acknowledged_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select()
    .single();
  if (updateError2 || !updatedItem2) {
    return NextResponse.json(
      { error: `Office task created (id ${officeTask.id}), but the brief item could not be updated: ${updateError2?.message ?? "unknown error"}` },
      { status: 500 }
    );
  }

  const body2: ConvertBriefItemResponse = {
    item: { ...(updatedItem2 as DailyBriefItem), project: null, carried_over_label: null, converted_label: "added to Office" },
    created: { kind: "office_task", id: officeTask.id },
  };
  return NextResponse.json(body2, { status: 201 });
}
