import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { buildLiveSnapshot } from "@/lib/estimate-live-snapshot";
import type {
  CreateEstimateVersionInput,
  EstimateVersion,
  EstimateVersionSummary,
} from "@/types/phase-12a-a";

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
  if (label.length > 80) {
    return NextResponse.json({ error: "label must be 80 characters or fewer" }, { status: 400 });
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
    const message = error.code === "23505"
      ? `A version labelled "${label}" already exists for this project.`
      : error.code === "42P01"
        ? "Estimate versioning is not installed. Apply database migration 019."
        : error.message;
    return NextResponse.json({ error: message }, { status });
  }

  return NextResponse.json({ version: version as EstimateVersion }, { status: 201 });
}
