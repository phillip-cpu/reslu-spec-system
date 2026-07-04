import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import type { PatchCostLineInput } from "@/types";

const VALID_QUOTE_STATUS = new Set(["Q", "S", "NA"]);

const EDITABLE_FIELDS = new Set([
  "description",
  "qty",
  "unit",
  "rate_ex_gst",
  "cost_ex_gst",
  "quoted_to_client_ex_gst",
  "actual_paid_ex_gst",
  "quote_status",
  "item_id",
  "notes",
  "sort",
]);

const NUMERIC_FIELDS = new Set([
  "qty",
  "rate_ex_gst",
  "cost_ex_gst",
  "quoted_to_client_ex_gst",
  "actual_paid_ex_gst",
  "sort",
]);

/**
 * PATCH /api/estimate/lines/[id]
 * body: PatchCostLineInput (partial). Validates quote_status enum per
 * the build brief ("PATCH validates quote_status enum"). Whitelisted
 * fields only — section_id/project_id are immutable via this route
 * (moving a line to another section is out of scope this release).
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

  let body: PatchCostLineInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (
    body.quote_status !== undefined &&
    body.quote_status !== null &&
    !VALID_QUOTE_STATUS.has(body.quote_status)
  ) {
    return NextResponse.json(
      { error: "quote_status must be one of Q, S, NA" },
      { status: 400 }
    );
  }

  const update: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!EDITABLE_FIELDS.has(key)) continue;
    if (NUMERIC_FIELDS.has(key)) {
      update[key] = value === "" || value === undefined ? null : Number(value);
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

  const { data: line, error } = await supabase
    .from("cost_lines")
    .update(update)
    .eq("id", id)
    .is("deleted_at", null)
    .select()
    .single();

  if (error) {
    const status = error.code === "23503" ? 400 : 500;
    return NextResponse.json({ error: error.message }, { status });
  }
  if (!line) {
    return NextResponse.json({ error: "Line not found" }, { status: 404 });
  }

  return NextResponse.json({ line });
}

/**
 * DELETE /api/estimate/lines/[id]
 * Soft-delete (deleted_at = now()) per BUILD-SPEC.md's cost_lines
 * column list ("...sort, deleted_at)") — financial line items keep an
 * audit trail rather than vanishing outright.
 *
 * Admin-only.
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
    .from("cost_lines")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
