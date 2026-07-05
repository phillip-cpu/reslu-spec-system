import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import type { EstimateVersion } from "@/types/phase-12a-a";

/**
 * GET /api/versions/[id]
 * Returns one estimate version WITH its full snapshot — the read-only
 * version viewer's data source (BUILD-SPEC.md: "versions list with
 * view (read-only render of snapshot)"). Not nested under
 * /api/projects/[id]/... (unlike most of this feature's routes)
 * because a version id is already globally unique and the viewer only
 * ever has the version id in hand (e.g. from the list), mirroring the
 * existing top-level pattern for singular child resources elsewhere in
 * this codebase (app/api/estimate/lines/[id], app/api/sow/lines/[lineId]).
 * Admin-only, financial.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();

  const info = await getUserRole(supabase);
  if (!info) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (info.role !== "admin") {
    return NextResponse.json({ error: "Only admins can access estimate versions" }, { status: 403 });
  }

  const { data: version, error } = await supabase
    .from("estimate_versions")
    .select("*")
    .eq("id", id)
    .single();

  if (error || !version) {
    return NextResponse.json({ error: "Version not found" }, { status: 404 });
  }

  return NextResponse.json({ version: version as EstimateVersion });
}

/**
 * DELETE /api/versions/[id]
 * Hard-delete a version (e.g. a mistaken "Save version" click) —
 * versions have no soft-delete column (per migration
 * 019_versions_sow_analysis.sql's comment: kept indefinitely by
 * default; this is the escape hatch for a genuine mistake, not a
 * routine action the UI surfaces prominently). Admin-only.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();

  const info = await getUserRole(supabase);
  if (!info) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (info.role !== "admin") {
    return NextResponse.json({ error: "Only admins can access estimate versions" }, { status: 403 });
  }

  const { error } = await supabase.from("estimate_versions").delete().eq("id", id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
