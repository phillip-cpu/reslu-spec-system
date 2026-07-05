import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { projectRollup, sectionRollup, ffeRollup, wholeJobSummary } from "@/lib/estimate";
import type { CostSectionWithLines, Measurement, MeasurementWithGroup } from "@/types";
import type {
  CreateEstimateVersionInput,
  EstimateSnapshot,
  EstimateVersion,
  EstimateVersionSummary,
} from "@/types/phase-12a-a";

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

/**
 * Builds a full frozen EstimateSnapshot for a project's CURRENT live
 * estimate state — the exact same query shape as
 * GET /api/projects/[id]/estimate, plus the project's latest SOW
 * revision label. Shared by POST (freeze into a new version) and the
 * compare route (when comparing a version against "current" rather
 * than another frozen version) — kept here rather than in lib/
 * because it needs a live Supabase client, unlike the pure diff/rollup
 * helpers in lib/estimate-versions.ts.
 */
export async function buildLiveSnapshot(
  supabase: SupabaseServerClient,
  projectId: string
): Promise<EstimateSnapshot | { error: string; status: number }> {
  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("id, estimate_markup_pct")
    .eq("id", projectId)
    .single();
  if (projectError || !project) {
    return { error: "Project not found", status: 404 };
  }

  const [
    { data: sections, error: sectionsError },
    { data: variations, error: variationsError },
    { data: items, error: itemsError },
    { data: measurementRows, error: measurementsError },
    { data: sowRows },
  ] = await Promise.all([
    supabase
      .from("cost_sections")
      .select("*, cost_lines(*)")
      .eq("project_id", projectId)
      .order("sort", { ascending: true }),
    supabase
      .from("variations")
      .select("status, cost_ex_gst")
      .eq("project_id", projectId)
      .is("deleted_at", null),
    supabase
      .from("items")
      .select("id, category, quantity, price_trade, price_rrp")
      .eq("project_id", projectId)
      .is("deleted_at", null),
    supabase
      .from("measurements")
      .select("*, measurement_groups(name)")
      .eq("project_id", projectId)
      .order("sort", { ascending: true }),
    supabase
      .from("sow_documents")
      .select("revision_label")
      .eq("project_id", projectId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(1),
  ]);

  if (sectionsError) return { error: sectionsError.message, status: 500 };
  if (variationsError) return { error: variationsError.message, status: 500 };
  if (itemsError) return { error: itemsError.message, status: 500 };
  if (measurementsError) return { error: measurementsError.message, status: 500 };

  const measurements: MeasurementWithGroup[] = (measurementRows ?? []).map((row) => {
    const { measurement_groups, ...rest } = row as unknown as Measurement & {
      measurement_groups: { name: string } | null;
    };
    return { ...(rest as Measurement), group_name: measurement_groups?.name ?? "" };
  });
  const measurementsById = new Map(measurements.map((m) => [m.id, { value: m.value }]));

  const sectionsWithLines: CostSectionWithLines[] = (sections ?? []).map((section) => {
    const lines = ((section as unknown as { cost_lines: CostSectionWithLines["lines"] }).cost_lines ?? [])
      .filter((l) => !l.deleted_at)
      .sort((a, b) => a.sort - b.sort);
    const { cost_lines: _omit, ...rest } = section as unknown as Record<string, unknown>;
    void _omit;
    return {
      ...(rest as unknown as CostSectionWithLines),
      lines,
      rollup: sectionRollup(lines, measurementsById),
    };
  });

  const allLines = sectionsWithLines.flatMap((s) => s.lines);
  const rollup = projectRollup({
    lines: allLines,
    variations: variations ?? [],
    markupPct: project.estimate_markup_pct ?? 0,
    measurementsById,
  });

  const ffe = ffeRollup(items ?? []);
  const wholeJob = wholeJobSummary(rollup, ffe);

  return {
    sections: sectionsWithLines,
    markup_pct: project.estimate_markup_pct ?? 0,
    rollup,
    ffe,
    wholeJob,
    measurements,
    sow_revision_label: sowRows?.[0]?.revision_label ?? null,
  };
}

/**
 * GET /api/projects/[id]/versions
 * Lists every estimate version for a project, newest first — the
 * snapshot payload is OMITTED from list rows (can be a large jsonb
 * blob across many sections/lines) per EstimateVersionSummary; fetch
 * GET /api/versions/[id] for the full snapshot. Admin-only — every
 * estimate surface is financial data (BUILD-SPEC.md §Financial
 * visibility), same gate as app/api/projects/[id]/estimate/route.ts.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const supabase = await createClient();

  const info = await getUserRole(supabase);
  if (!info) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (info.role !== "admin") {
    return NextResponse.json({ error: "Only admins can access estimate versions" }, { status: 403 });
  }

  const { data: versions, error } = await supabase
    .from("estimate_versions")
    .select("id, project_id, label, kind, note, created_by, created_at, updated_at")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ versions: (versions ?? []) as EstimateVersionSummary[] });
}

/**
 * POST /api/projects/[id]/versions
 * Freezes the project's CURRENT live estimate state into a new
 * estimate_versions row — "Save version" from the Estimate tab, per
 * BUILD-SPEC.md: "Actions: 'Save version' from the Estimate tab
 * (freeze current state)". body: CreateEstimateVersionInput — { label,
 * kind?, note? }. label must be unique per project (unique index) —
 * 409 on collision with a clear message. Admin-only.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const supabase = await createClient();

  const info = await getUserRole(supabase);
  if (!info) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (info.role !== "admin") {
    return NextResponse.json({ error: "Only admins can access estimate versions" }, { status: 403 });
  }

  let body: CreateEstimateVersionInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const label = body?.label?.trim();
  if (!label) {
    return NextResponse.json({ error: "label is required" }, { status: 400 });
  }
  const kind = body.kind === "vm" ? "vm" : "issue";

  const snapshot = await buildLiveSnapshot(supabase, projectId);
  if ("error" in snapshot) {
    return NextResponse.json({ error: snapshot.error }, { status: snapshot.status });
  }

  const { data: version, error } = await supabase
    .from("estimate_versions")
    .insert({
      project_id: projectId,
      label,
      kind,
      snapshot,
      note: body.note?.trim() || null,
      created_by: info.userId,
    })
    .select()
    .single();

  if (error) {
    const status = error.code === "23505" ? 409 : 500;
    const message =
      error.code === "23505"
        ? `A version labelled "${label}" already exists for this project.`
        : error.message;
    return NextResponse.json({ error: message }, { status });
  }

  return NextResponse.json({ version: version as EstimateVersion }, { status: 201 });
}
