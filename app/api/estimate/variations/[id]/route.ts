import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import type { PatchVariationInput } from "@/types";

const VALID_STATUS = new Set(["proposed", "approved", "rejected"]);

const EDITABLE_FIELDS = new Set([
  "description",
  "var_date",
  "cost_ex_gst",
  "status",
  "approved_by",
  "requested_by",
  "item_id",
  "notes",
]);

const NUMERIC_FIELDS = new Set(["cost_ex_gst"]);

/**
 * PATCH /api/estimate/variations/[id]
 * body: PatchVariationInput (partial). var_number is immutable via this
 * route — it's assigned once at creation and never renumbered, so the
 * register's numbering stays stable even if an earlier variation is
 * later deleted.
 *
 * Admin-only, per BUILD-SPEC.md §Financial visibility.
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

  let body: PatchVariationInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (body.status !== undefined && body.status !== null && !VALID_STATUS.has(body.status)) {
    return NextResponse.json(
      { error: "status must be one of proposed, approved, rejected" },
      { status: 400 }
    );
  }

  const update: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!EDITABLE_FIELDS.has(key)) continue;
    if (NUMERIC_FIELDS.has(key)) {
      update[key] = value === "" || value === undefined || value === null ? 0 : Number(value);
    } else if (key === "description" && typeof value === "string") {
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
  if (update.description === "") {
    return NextResponse.json({ error: "description cannot be empty" }, { status: 400 });
  }

  const { data: variation, error } = await supabase
    .from("variations")
    .update(update)
    .eq("id", id)
    .is("deleted_at", null)
    .select()
    .single();

  if (error) {
    const status = error.code === "23503" ? 400 : 500;
    return NextResponse.json({ error: error.message }, { status });
  }
  if (!variation) {
    return NextResponse.json({ error: "Variation not found" }, { status: 404 });
  }

  return NextResponse.json({ variation });
}

/**
 * DELETE /api/estimate/variations/[id]
 * Soft-delete (deleted_at = now()), preserving var_number history/audit
 * trail consistent with cost_lines. Admin-only.
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

  const { error } = await supabase
    .from("variations")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
