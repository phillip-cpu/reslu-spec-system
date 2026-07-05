import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { crossReferencePlans, computeTakeoffs } from "@/lib/takeoff";
import type {
  MeasurementWithTakeoffFields,
  PlanAnalysis,
  PlanAnalysisSummaryResponse,
  SubmitPlanAnalysisInput,
  SubmitPlanAnalysisResponse,
} from "@/types/phase-12a-a";

/** The measurement_groups.name every takeoff-derived draft measurement lands in — created on first use per project. */
const TAKEOFF_GROUP_NAME = "Takeoff — Draft (from plan analysis)";

/**
 * GET /api/projects/[id]/plan-analysis
 * Latest plan analysis for the project (or null) — backs the overview
 * card ("Plan check: N discrepancies" per BUILD-SPEC.md). Team access.
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

  const { data: latest, error } = await supabase
    .from("plan_analyses")
    .select("*")
    .eq("project_id", projectId)
    .order("analysed_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const payload: PlanAnalysisSummaryResponse = { latest: (latest as PlanAnalysis | null) ?? null };
  return NextResponse.json(payload);
}

/**
 * POST /api/projects/[id]/plan-analysis
 * BUILD-SPEC.md "Aria plan analysis": "POST /api/projects/[id]/plan-analysis
 * results ... Aria submits rooms[], item_codes[], dimensions per room
 * -> server runs deterministic cross-reference vs items/register (both
 * directions + room name mismatches) storing discrepancies jsonb" plus
 * "Aria takeoff assist": stated dimensions -> the SYSTEM computes draft
 * quantities deterministically, written to Areas & Measurements as
 * status 'draft'.
 *
 * body: SubmitPlanAnalysisInput — { file_id, revision_label?, rooms,
 * item_codes, dimensions?, analysed_by? }. file_id must be a 'plans'
 * kind project_files row belonging to this project. Team access — this
 * is Aria's primary write path (via her JWT, same trust level as any
 * other team member's session) alongside a human re-running analysis
 * from the UI; nothing here publishes/issues anything (the SOW draft
 * step is a SEPARATE MCP tool, draft_sow_section, and even that only
 * ever writes draft sow_lines — never issues).
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

  let body: SubmitPlanAnalysisInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body?.file_id) {
    return NextResponse.json({ error: "file_id is required" }, { status: 400 });
  }
  const rooms = Array.isArray(body.rooms) ? body.rooms.filter((r) => typeof r === "string" && r.trim()) : [];
  const itemCodes = Array.isArray(body.item_codes)
    ? body.item_codes.filter((c) => typeof c === "string" && c.trim())
    : [];
  const dimensions = Array.isArray(body.dimensions) ? body.dimensions : [];

  const { data: file, error: fileError } = await supabase
    .from("project_files")
    .select("id, kind")
    .eq("id", body.file_id)
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .single();
  if (fileError || !file) {
    return NextResponse.json({ error: "Plan file not found for this project" }, { status: 404 });
  }
  if (file.kind !== "plans") {
    return NextResponse.json({ error: "file_id must reference a project_files row of kind 'plans'" }, { status: 400 });
  }

  // ---- Cross-reference engine (deterministic, per lib/takeoff.ts) ----
  const [{ data: registerItemsRaw }, { data: projectRoomsRaw }] = await Promise.all([
    supabase
      .from("items")
      .select("item_code, location")
      .eq("project_id", projectId)
      .is("deleted_at", null),
    supabase.from("rooms").select("name").eq("project_id", projectId).is("deleted_at", null),
  ]);

  const discrepancies = crossReferencePlans({
    planRooms: rooms,
    planItemCodes: itemCodes,
    registerItems: (registerItemsRaw ?? []) as { item_code: string; location: string | null }[],
    projectRooms: (projectRoomsRaw ?? []).map((r) => r.name as string),
  });

  const { data: analysis, error: insertError } = await supabase
    .from("plan_analyses")
    .insert({
      project_id: projectId,
      file_id: body.file_id,
      revision_label: body.revision_label?.trim() || null,
      rooms,
      item_codes: itemCodes,
      dimensions,
      discrepancies,
      analysed_by: body.analysed_by?.trim() || null,
    })
    .select()
    .single();

  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  // ---- Takeoff assist: draft measurements from stated dimensions ----
  // Only rooms with at least length+width annotated produce a real
  // takeoff; unannotated rooms are skipped entirely here (no
  // measurement row at all) rather than writing a zero/guessed value —
  // per BUILD-SPEC.md "anything unannotated is flagged, not guessed".
  const takeoffs = computeTakeoffs(dimensions).filter((t) => !t.unannotated);
  const measurementsDrafted: MeasurementWithTakeoffFields[] = [];

  if (takeoffs.length > 0) {
    let { data: group } = await supabase
      .from("measurement_groups")
      .select("id")
      .eq("project_id", projectId)
      .eq("name", TAKEOFF_GROUP_NAME)
      .maybeSingle();

    if (!group) {
      const { data: maxRow } = await supabase
        .from("measurement_groups")
        .select("sort")
        .eq("project_id", projectId)
        .order("sort", { ascending: false })
        .limit(1)
        .maybeSingle();
      const { data: newGroup, error: groupError } = await supabase
        .from("measurement_groups")
        .insert({
          project_id: projectId,
          name: TAKEOFF_GROUP_NAME,
          sort: (maxRow?.sort ?? 0) + 1,
        })
        .select("id")
        .single();
      if (groupError || !newGroup) {
        // Cross-reference + analysis row are already saved — a failure
        // here degrades to "no draft measurements written" rather than
        // losing the analysis itself.
        return NextResponse.json({
          analysis: analysis as PlanAnalysis,
          measurements_drafted: [],
        } satisfies SubmitPlanAnalysisResponse);
      }
      group = newGroup;
    }

    const { data: maxMeasurementSort } = await supabase
      .from("measurements")
      .select("sort")
      .eq("group_id", group.id)
      .order("sort", { ascending: false })
      .limit(1)
      .maybeSingle();
    let nextSort = (maxMeasurementSort?.sort ?? 0) + 1;

    const rows = takeoffs.flatMap((t) => {
      const entries: {
        group_id: string;
        project_id: string;
        label: string;
        value: number;
        unit: string;
        status: "draft";
        source: "takeoff";
        provenance_note: string;
        sort: number;
      }[] = [];
      if (t.floor_m2 !== null) {
        entries.push({
          group_id: group!.id,
          project_id: projectId,
          label: `${t.room_name} — Floor area`,
          value: t.floor_m2,
          unit: "m2",
          status: "draft",
          source: "takeoff",
          provenance_note: t.provenance_note,
          sort: nextSort++,
        });
      }
      if (t.painting_m2 !== null) {
        entries.push({
          group_id: group!.id,
          project_id: projectId,
          label: `${t.room_name} — Painting area`,
          value: t.painting_m2,
          unit: "m2",
          status: "draft",
          source: "takeoff",
          provenance_note: t.provenance_note,
          sort: nextSort++,
        });
      }
      if (t.tiling_m2 !== null) {
        entries.push({
          group_id: group!.id,
          project_id: projectId,
          label: `${t.room_name} — Tiling area`,
          value: t.tiling_m2,
          unit: "m2",
          status: "draft",
          source: "takeoff",
          provenance_note: t.provenance_note,
          sort: nextSort++,
        });
      }
      return entries;
    });

    if (rows.length > 0) {
      const { data: inserted, error: measurementsError } = await supabase
        .from("measurements")
        .insert(rows)
        .select();
      if (!measurementsError) {
        measurementsDrafted.push(...((inserted ?? []) as MeasurementWithTakeoffFields[]));
      }
    }
  }

  const payload: SubmitPlanAnalysisResponse = {
    analysis: analysis as PlanAnalysis,
    measurements_drafted: measurementsDrafted,
  };
  return NextResponse.json(payload, { status: 201 });
}
