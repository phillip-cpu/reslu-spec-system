import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { measurementGroupTotal } from "@/lib/estimate";
import type { CreateMeasurementGroupInput, MeasurementGroupWithRows } from "@/types";

/**
 * GET /api/projects/[id]/estimate/measurements/groups
 * Returns the project's measurement groups (Floor Areas, Tiling Areas,
 * plus any custom groups — "groups editable" per BUILD-SPEC.md) with
 * their measurement rows nested and a per-group total.
 *
 * Admin-only, per BUILD-SPEC.md §Financial visibility.
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
    return NextResponse.json(
      { error: "Only admins can access the Estimate module" },
      { status: 403 }
    );
  }

  const { data: groups, error } = await supabase
    .from("measurement_groups")
    .select("*, measurements(*)")
    .eq("project_id", projectId)
    .order("sort", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const payload: MeasurementGroupWithRows[] = (groups ?? []).map((group) => {
    const rows = (
      (group as unknown as { measurements: MeasurementGroupWithRows["measurements"] }).measurements ?? []
    ).sort((a, b) => a.sort - b.sort);
    const { measurements: _omit, ...rest } = group as unknown as Record<string, unknown>;
    void _omit;
    return {
      ...(rest as MeasurementGroupWithRows),
      measurements: rows,
      total: measurementGroupTotal(rows.map((r) => r.value)),
    };
  });

  return NextResponse.json({ groups: payload });
}

/**
 * POST /api/projects/[id]/estimate/measurements/groups
 * Adds a new measurement group. Admin-only.
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
    return NextResponse.json(
      { error: "Only admins can access the Estimate module" },
      { status: 403 }
    );
  }

  let body: CreateMeasurementGroupInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body?.name?.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const { data: existing } = await supabase
    .from("measurement_groups")
    .select("sort")
    .eq("project_id", projectId)
    .order("sort", { ascending: false })
    .limit(1);
  const nextSort = (existing?.[0]?.sort ?? 0) + 1;

  const { data: group, error } = await supabase
    .from("measurement_groups")
    .insert({ project_id: projectId, name: body.name.trim(), sort: nextSort })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(
    { group: { ...group, measurements: [], total: 0 } },
    { status: 201 }
  );
}
