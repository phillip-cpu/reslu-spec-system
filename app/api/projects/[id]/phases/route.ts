import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { CreatePhaseInput, PhasesListResponse, SchedulePhaseWithContact } from "@/types";

const VALID_COLORS = new Set(["sand", "charcoal", "teal", "amber"]);
const SORT_STEP = 1000;

/**
 * GET /api/projects/[id]/phases
 * Team-visible (scheduling data, not financial). Response:
 * { phases: SchedulePhaseWithContact[] }, non-deleted, sorted, each
 * annotated with a lightweight contact summary (batched lookup, not
 * N+1). Aria-relevant (read-only schedule visibility).
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

  const { data: phases, error } = await supabase
    .from("schedule_phases")
    .select("*")
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .order("sort", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const contactIds = [...new Set((phases ?? []).map((p) => p.contact_id).filter(Boolean))] as string[];
  const { data: contacts } = contactIds.length
    ? await supabase.from("contacts").select("id,company,contact_name").in("id", contactIds)
    : { data: [] as { id: string; company: string; contact_name: string | null }[] };
  const contactById = new Map((contacts ?? []).map((c) => [c.id, c]));

  const result: SchedulePhaseWithContact[] = (phases ?? []).map((p) => ({
    ...p,
    contact: p.contact_id ? contactById.get(p.contact_id) ?? null : null,
  }));

  const body: PhasesListResponse = { phases: result };
  return NextResponse.json(body);
}

/**
 * POST /api/projects/[id]/phases
 * body: CreatePhaseInput — { name, start_date, end_date, color_key?,
 * contact_id?, notes? }. Response: { phase } (201). end_date >=
 * start_date is enforced both here (400, friendly message) and by the
 * DB check constraint (chk_schedule_phases_dates in migration 013) as
 * a second line of defence. `sort` = server-computed max(existing) +
 * SORT_STEP. Aria-relevant.
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

  const { data: project } = await supabase
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .single();
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  let body: CreatePhaseInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.name?.trim() || !body.start_date || !body.end_date) {
    return NextResponse.json(
      { error: "name, start_date and end_date are required" },
      { status: 400 }
    );
  }
  if (body.end_date < body.start_date) {
    return NextResponse.json(
      { error: "end_date must be on or after start_date" },
      { status: 400 }
    );
  }
  const colorKey = body.color_key ?? "sand";
  if (!VALID_COLORS.has(colorKey)) {
    return NextResponse.json(
      { error: "color_key must be one of sand, charcoal, teal, amber" },
      { status: 400 }
    );
  }

  const { data: maxRow } = await supabase
    .from("schedule_phases")
    .select("sort")
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .order("sort", { ascending: false })
    .limit(1)
    .maybeSingle();

  const nextSort = (maxRow?.sort ?? -SORT_STEP) + SORT_STEP;

  const { data: phase, error } = await supabase
    .from("schedule_phases")
    .insert({
      project_id: projectId,
      name: body.name.trim(),
      start_date: body.start_date,
      end_date: body.end_date,
      color_key: colorKey,
      contact_id: body.contact_id || null,
      notes: body.notes?.trim() || null,
      sort: nextSort,
    })
    .select()
    .single();

  if (error) {
    const status = error.code === "23503" || error.code === "23514" ? 400 : 500;
    return NextResponse.json({ error: error.message }, { status });
  }

  return NextResponse.json({ phase }, { status: 201 });
}
