import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { loadItemScheduleRequirementData } from "@/lib/item-schedule-requirements-server";
import type {
  ItemScheduleRequirementRow,
  ItemScheduleRequirementsResponse,
} from "@/types/item-schedule-requirements";

function cleanBufferDays(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 365 ? parsed : null;
}

function cleanNotes(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const notes = value.trim();
  return notes ? notes.slice(0, 1000) : null;
}

async function getAuthedProject(
  supabase: Awaited<ReturnType<typeof createClient>>,
  projectId: string
): Promise<"ok" | "unauthorized" | "not_found"> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return "unauthorized";
  const { data } = await supabase.from("projects").select("id").eq("id", projectId).maybeSingle();
  return data ? "ok" : "not_found";
}

async function responseForProject(
  supabase: Awaited<ReturnType<typeof createClient>>,
  projectId: string
) {
  const data = await loadItemScheduleRequirementData(supabase, [projectId], {
    includeAllActivities: true,
    includeContractors: true,
  });
  const body: ItemScheduleRequirementsResponse = {
    requirements: data.requirements,
    activities: data.activities,
  };
  return NextResponse.json(body);
}

/** FF&E required-on-site links plus selectable Work activities. */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const supabase = await createClient();
  const access = await getAuthedProject(supabase, projectId);
  if (access === "unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (access === "not_found") return NextResponse.json({ error: "Project not found" }, { status: 404 });

  try {
    return await responseForProject(supabase, projectId);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not load required activities" },
      { status: 500 }
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const supabase = await createClient();
  const access = await getAuthedProject(supabase, projectId);
  if (access === "unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (access === "not_found") return NextResponse.json({ error: "Project not found" }, { status: 404 });

  let body: { item_id?: unknown; board_task_id?: unknown; buffer_days?: unknown; notes?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const itemId = typeof body.item_id === "string" && body.item_id ? body.item_id : null;
  const boardTaskId = typeof body.board_task_id === "string" && body.board_task_id ? body.board_task_id : null;
  const bufferDays = cleanBufferDays(body.buffer_days);
  const notes = cleanNotes(body.notes);
  if (!itemId || !boardTaskId || bufferDays === null || notes === undefined) {
    return NextResponse.json({ error: "Valid item_id, board_task_id, buffer_days and notes are required" }, { status: 400 });
  }

  const { error } = await supabase.from("item_schedule_requirements").insert({
    project_id: projectId,
    item_id: itemId,
    board_task_id: boardTaskId,
    buffer_days: bufferDays,
    notes,
    created_by: (await supabase.auth.getUser()).data.user?.id ?? null,
  });
  if (error) {
    const duplicate = error.code === "23505";
    return NextResponse.json(
      { error: duplicate ? "This item is already linked to that Work activity" : error.message },
      { status: duplicate ? 409 : 400 }
    );
  }

  try {
    return await responseForProject(supabase, projectId);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Requirement saved but could not be reloaded" },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const supabase = await createClient();
  const access = await getAuthedProject(supabase, projectId);
  if (access === "unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (access === "not_found") return NextResponse.json({ error: "Project not found" }, { status: 404 });

  let body: { requirement_id?: unknown; buffer_days?: unknown; notes?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const requirementId = typeof body.requirement_id === "string" && body.requirement_id ? body.requirement_id : null;
  const bufferDays = body.buffer_days === undefined ? undefined : cleanBufferDays(body.buffer_days);
  const notes = cleanNotes(body.notes);
  if (!requirementId || bufferDays === null || (body.notes !== undefined && notes === undefined)) {
    return NextResponse.json({ error: "Invalid requirement update" }, { status: 400 });
  }
  const patch: Partial<Pick<ItemScheduleRequirementRow, "buffer_days" | "notes">> = {};
  if (bufferDays !== undefined) patch.buffer_days = bufferDays;
  if (notes !== undefined) patch.notes = notes;
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("item_schedule_requirements")
    .update(patch)
    .eq("id", requirementId)
    .eq("project_id", projectId)
    .select("id")
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  if (!data) return NextResponse.json({ error: "Requirement not found" }, { status: 404 });
  return responseForProject(supabase, projectId);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const supabase = await createClient();
  const access = await getAuthedProject(supabase, projectId);
  if (access === "unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (access === "not_found") return NextResponse.json({ error: "Project not found" }, { status: 404 });

  let body: { requirement_id?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const requirementId = typeof body.requirement_id === "string" && body.requirement_id ? body.requirement_id : null;
  if (!requirementId) return NextResponse.json({ error: "requirement_id is required" }, { status: 400 });

  const { data, error } = await supabase
    .from("item_schedule_requirements")
    .delete()
    .eq("id", requirementId)
    .eq("project_id", projectId)
    .select("id")
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  if (!data) return NextResponse.json({ error: "Requirement not found" }, { status: 404 });
  return responseForProject(supabase, projectId);
}

