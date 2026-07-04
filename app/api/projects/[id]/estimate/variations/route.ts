import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import type { CreateVariationInput } from "@/types";

const VALID_STATUS = new Set(["proposed", "approved", "rejected"]);

/**
 * GET /api/projects/[id]/estimate/variations
 * Returns the project's Variations Register, ordered by var_number.
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

  const { data: variations, error } = await supabase
    .from("variations")
    .select("*")
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .order("var_number", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ variations: variations ?? [] });
}

/**
 * POST /api/projects/[id]/estimate/variations
 * Creates a variation with an auto-assigned var_number = max(existing,
 * including soft-deleted, to avoid ever reusing a number a client may
 * already have referenced) + 1, per BUILD-SPEC.md "var number (auto)".
 *
 * Admin-only.
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

  let body: CreateVariationInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body?.description?.trim()) {
    return NextResponse.json({ error: "description is required" }, { status: 400 });
  }
  if (body.status && !VALID_STATUS.has(body.status)) {
    return NextResponse.json(
      { error: "status must be one of proposed, approved, rejected" },
      { status: 400 }
    );
  }

  // max+1 including soft-deleted rows, per the unique index
  // idx_variations_project_number_active (unique among deleted_at is
  // null) — but we still never want to reissue a number that a
  // deleted-but-once-real variation used, hence scanning all rows here
  // rather than just active ones.
  const { data: existing } = await supabase
    .from("variations")
    .select("var_number")
    .eq("project_id", projectId)
    .order("var_number", { ascending: false })
    .limit(1);
  const nextNumber = (existing?.[0]?.var_number ?? 0) + 1;

  const { data: variation, error } = await supabase
    .from("variations")
    .insert({
      project_id: projectId,
      var_number: nextNumber,
      var_date: body.var_date || new Date().toISOString().slice(0, 10),
      description: body.description.trim(),
      cost_ex_gst: body.cost_ex_gst ?? 0,
      status: body.status ?? "proposed",
      approved_by: body.approved_by?.trim() || null,
      requested_by: body.requested_by?.trim() || null,
      item_id: body.item_id ?? null,
      notes: body.notes?.trim() || null,
    })
    .select()
    .single();

  if (error) {
    const status = error.code === "23503" ? 400 : 500;
    return NextResponse.json({ error: error.message }, { status });
  }

  return NextResponse.json({ variation }, { status: 201 });
}
