import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { PatchPhaseInput } from "@/types";

const VALID_COLORS = new Set(["sand", "charcoal", "teal", "amber"]);

const EDITABLE_FIELDS = new Set([
  "name",
  "start_date",
  "end_date",
  "color_key",
  "contact_id",
  "notes",
  "sort",
]);

/**
 * PATCH /api/phases/[id]
 * body: PatchPhaseInput (partial). Validates color_key enum and
 * end_date >= start_date across the MERGED result (existing + patch)
 * so a partial update — e.g. only moving start_date later — can't
 * silently create an invalid range that the DB constraint would then
 * reject with a raw Postgres error. Response: { phase }.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: existing } = await supabase
    .from("schedule_phases")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .single();
  if (!existing) {
    return NextResponse.json({ error: "Phase not found" }, { status: 404 });
  }

  let body: PatchPhaseInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (body.color_key !== undefined && !VALID_COLORS.has(body.color_key)) {
    return NextResponse.json(
      { error: "color_key must be one of sand, charcoal, teal, amber" },
      { status: 400 }
    );
  }

  const nextStart = body.start_date ?? existing.start_date;
  const nextEnd = body.end_date ?? existing.end_date;
  if (nextEnd < nextStart) {
    return NextResponse.json(
      { error: "end_date must be on or after start_date" },
      { status: 400 }
    );
  }

  const update: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(body)) {
    if (!EDITABLE_FIELDS.has(key)) continue;
    if (key === "name") {
      const trimmed = typeof raw === "string" ? raw.trim() : raw;
      if (!trimmed) {
        return NextResponse.json({ error: "name cannot be empty" }, { status: 400 });
      }
      update.name = trimmed;
    } else if (key === "sort") {
      update.sort = Number(raw);
    } else if (typeof raw === "string") {
      update[key] = raw.trim() || (key === "notes" ? null : raw.trim());
    } else {
      update[key] = raw;
    }
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const { data: phase, error } = await supabase
    .from("schedule_phases")
    .update(update)
    .eq("id", id)
    .is("deleted_at", null)
    .select()
    .single();

  if (error) {
    const status = error.code === "23503" || error.code === "23514" ? 400 : 500;
    return NextResponse.json({ error: error.message }, { status });
  }

  return NextResponse.json({ phase });
}

/**
 * DELETE /api/phases/[id]
 * Soft-delete (deleted_at) — parity with items/cost_lines/variations/
 * board_tasks.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { error } = await supabase
    .from("schedule_phases")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .is("deleted_at", null);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
