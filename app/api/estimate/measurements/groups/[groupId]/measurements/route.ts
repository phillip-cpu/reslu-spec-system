import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import type { CreateMeasurementInput } from "@/types";

/**
 * POST /api/estimate/measurements/groups/[groupId]/measurements
 * Adds a measurement row to a group. project_id is looked up
 * server-side from the parent group (never trusted from the client),
 * mirroring the cost_lines pattern.
 *
 * Admin-only, per BUILD-SPEC.md §Financial visibility.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ groupId: string }> }
) {
  const { groupId } = await params;
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

  const { data: group } = await supabase
    .from("measurement_groups")
    .select("id, project_id")
    .eq("id", groupId)
    .single();
  if (!group) {
    return NextResponse.json({ error: "Group not found" }, { status: 404 });
  }

  let body: CreateMeasurementInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body?.label?.trim()) {
    return NextResponse.json({ error: "label is required" }, { status: 400 });
  }

  const { data: existing } = await supabase
    .from("measurements")
    .select("sort")
    .eq("group_id", groupId)
    .order("sort", { ascending: false })
    .limit(1);
  const nextSort = (existing?.[0]?.sort ?? 0) + 1;

  const { data: measurement, error } = await supabase
    .from("measurements")
    .insert({
      group_id: groupId,
      project_id: group.project_id,
      label: body.label.trim(),
      value: body.value ?? 0,
      unit: body.unit?.trim() || "m2",
      item_id: body.item_id ?? null,
      notes: body.notes?.trim() || null,
      sort: nextSort,
    })
    .select()
    .single();

  if (error) {
    const status = error.code === "23503" ? 400 : 500;
    return NextResponse.json({ error: error.message }, { status });
  }

  return NextResponse.json({ measurement }, { status: 201 });
}
