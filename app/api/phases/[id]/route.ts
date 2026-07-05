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

// Fields that are always system-managed and can never be set by a
// client PATCH, regardless of phase kind — silently stripped rather
// than 400ing, consistent with EDITABLE_FIELDS already only picking
// up recognised keys (anything not in EDITABLE_FIELDS, including
// `kind`/`cost_section_id`, is already ignored by the loop below; this
// constant exists purely so that fact is documented explicitly rather
// than left implicit).
const SYSTEM_MANAGED_FIELDS = new Set(["kind", "cost_section_id"]);

// Fields that are blocked outright on an umbrella-kind phase — its
// dates/name are system-recomputed on every GET (see
// app/api/projects/[id]/phases/route.ts), so a client edit to them
// would just be silently overwritten on the next read anyway; this
// returns an explicit 400 instead of a confusing no-op.
const UMBRELLA_RESTRICTED_FIELDS = new Set(["name", "start_date", "end_date"]);

/**
 * PATCH /api/phases/[id]
 * body: PatchPhaseInput (partial). Validates color_key enum and
 * end_date >= start_date across the MERGED result (existing + patch)
 * so a partial update — e.g. only moving start_date later — can't
 * silently create an invalid range that the DB constraint would then
 * reject with a raw Postgres error. Response: { phase }.
 *
 * `kind` and `cost_section_id` are never client-editable (see
 * SYSTEM_MANAGED_FIELDS — they simply aren't in EDITABLE_FIELDS, so
 * they're silently stripped from the update, same handling as any
 * other unrecognised key in the body).
 *
 * If the phase being patched is kind === 'umbrella', any attempt to
 * touch name/start_date/end_date is rejected with 400 — those fields
 * are system-recomputed on every GET /api/projects/[id]/phases call
 * (umbrella recompute-on-read), so a direct edit here would either be
 * silently clobbered on the next read (confusing) or fight the
 * recompute logic. Other fields (color_key, contact_id, notes, sort)
 * remain editable on an umbrella phase — there's no reason to block
 * cosmetic/organisational edits, only the system-managed span.
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

  if (existing.kind === "umbrella") {
    const touchesRestricted = Object.keys(body).some((k) => UMBRELLA_RESTRICTED_FIELDS.has(k));
    if (touchesRestricted) {
      return NextResponse.json(
        { error: "Umbrella phase dates and name are system-managed and cannot be edited directly." },
        { status: 400 }
      );
    }
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
    if (!EDITABLE_FIELDS.has(key)) continue; // silently strips kind/cost_section_id and any other unrecognised key
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
 *
 * Deleting an umbrella phase directly IS allowed (no special-case
 * block) — the simplest correct behaviour, since the next
 * GET /api/projects/[id]/phases will simply recreate it if the
 * "Preliminaries & Site" cost section still has live lines. There is
 * no data-loss risk in allowing it: the umbrella phase carries no
 * team-authored content of its own (its dates/name are system-derived,
 * and cost_section_lines are read live from cost_lines, not stored
 * on the phase), so deleting it is at worst a no-op until the next read.
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
