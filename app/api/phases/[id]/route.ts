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
 * FIX ROUND A — "Site Setup umbrella span" fix: umbrella-kind phases
 * are NO LONGER blocked from editing name/start_date/end_date here.
 * The old restriction existed because those fields used to be
 * recomputed on every GET (auto-span-to-whole-project, judged wrong by
 * Phillip's testing) — that recompute is gone (see
 * app/api/projects/[id]/phases/route.ts's GET doc comment), so an
 * umbrella phase is now edited through this exact same route/path as
 * any ordinary phase, with zero special-casing below.
 *
 * FIX ROUND A — phase unification: when `name` changes, the linked
 * board_groups row (migration 023's board_groups.phase_id) has its
 * `name` mirrored to match, keeping THE INVARIANT documented in full
 * in app/api/projects/[id]/phases/route.ts's GET doc comment
 * ("schedule_phases.name is the single source of truth ... renaming
 * either renames both"). A phase with no linked board_groups row
 * (phase_id relationship absent — legacy/unreconciled data) simply has
 * nothing to sync; this is a best-effort mirror, not enforced by a DB
 * constraint.
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

  // ---- Unification: mirror a name change into the linked board_groups row ----
  if (typeof update.name === "string") {
    await supabase
      .from("board_groups")
      .update({ name: update.name })
      .eq("phase_id", id);
  }

  return NextResponse.json({ phase });
}

/**
 * DELETE /api/phases/[id]
 * Soft-delete (deleted_at) — parity with items/cost_lines/variations/
 * board_tasks.
 *
 * Deleting an umbrella phase directly IS allowed (no special-case
 * block) — since the umbrella no longer auto-recreates itself with
 * system-derived dates on every read (Fix Round A removed that
 * recompute-on-read behaviour entirely — see
 * app/api/projects/[id]/phases/route.ts's GET doc comment), deleting
 * it now behaves exactly like deleting any ordinary phase: gone until
 * a human adds a new one (the shared seed path only ever runs once,
 * when a project has ZERO phases — see seedPhaseTemplateIfEmpty in
 * that same route — so deleting the umbrella alone, with ordinary
 * phases still present, does NOT reseed it).
 *
 * FIX ROUND A — phase unification: the linked board_groups row
 * (migration 023's phase_id) is NOT deleted here — only its phase_id
 * link is cleared (board_tasks in that group survive, same as
 * DELETE /api/board-groups/[id]'s existing "cards are not deleted"
 * behaviour), consistent with how deleting a phase should not silently
 * destroy Board task-grouping history.
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

  await supabase.from("board_groups").update({ phase_id: null }).eq("phase_id", id);

  return NextResponse.json({ ok: true });
}
