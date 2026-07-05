import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import type { PatchMeasurementInput } from "@/types";
import type { PatchMeasurementStatusInput } from "@/types/phase-12a-a";

/**
 * Phase 12a-A additive: this route's body may also carry `status`
 * (see PatchMeasurementStatusInput in types/phase-12a-a.ts — kept out
 * of the shared types/index.ts per this feature's file boundary).
 */
type PatchMeasurementInputWithStatus = PatchMeasurementInput & PatchMeasurementStatusInput;

// Phase 12a-A: "status" added so the takeoff assist's "Confirm" action
// (site measure verifies a draft, takeoff-derived measurement) can flip
// measurements.status 'draft' -> 'verified' via this same route,
// without a new endpoint — see BUILD-SPEC.md "Aria takeoff assist":
// "Site measure confirms -> measurement status 'verified'".
const EDITABLE_FIELDS = new Set(["label", "value", "unit", "item_id", "notes", "sort", "status"]);
const NUMERIC_FIELDS = new Set(["value", "sort"]);
const VALID_STATUS = new Set(["draft", "verified"]);

/**
 * PATCH /api/estimate/measurements/[id]
 * body: PatchMeasurementInput (partial). Admin-only, per
 * BUILD-SPEC.md §Financial visibility (the whole Estimate module,
 * including Areas & Measurements, is gated as a unit).
 */
export async function PATCH(
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
    return NextResponse.json(
      { error: "Only admins can access the Estimate module" },
      { status: 403 }
    );
  }

  let body: PatchMeasurementInputWithStatus;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const update: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!EDITABLE_FIELDS.has(key)) continue;
    if (NUMERIC_FIELDS.has(key)) {
      update[key] = value === "" || value === undefined || value === null ? 0 : Number(value);
    } else if (key === "label" && typeof value === "string") {
      update[key] = value.trim();
    } else if (typeof value === "string") {
      update[key] = value.trim() || null;
    } else {
      update[key] = value;
    }
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }
  if (update.label === "") {
    return NextResponse.json({ error: "label cannot be empty" }, { status: 400 });
  }
  if (update.status !== undefined && !VALID_STATUS.has(update.status as string)) {
    return NextResponse.json({ error: "status must be 'draft' or 'verified'" }, { status: 400 });
  }

  const { data: measurement, error } = await supabase
    .from("measurements")
    .update(update)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    const status = error.code === "23503" ? 400 : 500;
    return NextResponse.json({ error: error.message }, { status });
  }
  if (!measurement) {
    return NextResponse.json({ error: "Measurement not found" }, { status: 404 });
  }

  return NextResponse.json({ measurement });
}

/**
 * DELETE /api/estimate/measurements/[id]
 * Hard-delete — measurements have no deleted_at column (per
 * 007_estimating.sql; only cost_lines and variations carry soft-delete
 * for financial-record audit trail purposes). Admin-only.
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
    return NextResponse.json(
      { error: "Only admins can access the Estimate module" },
      { status: 403 }
    );
  }

  const { error } = await supabase.from("measurements").delete().eq("id", id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
