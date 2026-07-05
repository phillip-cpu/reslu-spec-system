import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { PatchVisitInput, ArrivalSlot } from "@/lib/trade-visits";

const VALID_SLOTS = new Set<ArrivalSlot>(["first_thing", "midday", "afternoon"]);

// Only plain scheduling fields are client-editable here. status,
// confirm_token, confirmed_at, confirmed_by, proposed_*, and
// reminder_sent_at are all system/trade/staff-workflow-managed via
// the dedicated /confirm and /resolve-proposal routes (and the public
// /api/trade/[token]/respond route) — silently stripped from a PATCH
// here, same EDITABLE_FIELDS pattern as app/api/phases/[id]/route.ts.
const EDITABLE_FIELDS = new Set([
  "contact_id",
  "start_date",
  "end_date",
  "arrival_slot",
  "arrival_time",
  "notes",
]);

/**
 * PATCH /api/visits/[id]
 * Team session. Body: PatchVisitInput (partial) — dates/slot/time/
 * notes/contact_id only. Rejects the edit (400) if the parent phase
 * is kind === 'umbrella' (defensive — should be structurally
 * impossible since umbrella phases can never have visits created
 * against them via POST /api/projects/[id]/visits, but checked here
 * too in case a visit's phase_id is ever repointed in the future).
 * Response: { visit }.
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
    .from("trade_visits")
    .select("*, phase:schedule_phases(kind)")
    .eq("id", id)
    .is("deleted_at", null)
    .single();
  if (!existing) {
    return NextResponse.json({ error: "Visit not found" }, { status: 404 });
  }

  const phaseKind = (existing as unknown as { phase: { kind: string } | null }).phase?.kind;
  if (phaseKind === "umbrella") {
    return NextResponse.json(
      { error: "Cannot edit visits belonging to the Site Setup umbrella phase" },
      { status: 400 }
    );
  }

  let body: PatchVisitInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (body.arrival_slot !== undefined && body.arrival_slot !== null && !VALID_SLOTS.has(body.arrival_slot)) {
    return NextResponse.json(
      { error: "arrival_slot must be one of first_thing, midday, afternoon" },
      { status: 400 }
    );
  }

  const nextStart = body.start_date ?? existing.start_date;
  const nextEnd = body.end_date ?? existing.end_date;
  if (nextEnd < nextStart) {
    return NextResponse.json({ error: "end_date must be on or after start_date" }, { status: 400 });
  }

  if (body.contact_id) {
    const { data: contact } = await supabase
      .from("contacts")
      .select("id")
      .eq("id", body.contact_id)
      .is("deleted_at", null)
      .maybeSingle();
    if (!contact) {
      return NextResponse.json({ error: "Contact not found" }, { status: 404 });
    }
  }

  const update: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(body)) {
    if (!EDITABLE_FIELDS.has(key)) continue; // strips status/confirm_token/proposed_*/etc.
    if (typeof raw === "string") {
      update[key] = raw.trim() || (key === "notes" ? null : raw.trim());
    } else {
      update[key] = raw;
    }
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const { data: visit, error } = await supabase
    .from("trade_visits")
    .update(update)
    .eq("id", id)
    .is("deleted_at", null)
    .select()
    .single();

  if (error) {
    const status = error.code === "23503" || error.code === "23514" ? 400 : 500;
    return NextResponse.json({ error: error.message }, { status });
  }

  return NextResponse.json({ visit });
}

/**
 * DELETE /api/visits/[id]
 * Soft delete (deleted_at) — team session, parity with phases/items.
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
    .from("trade_visits")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .is("deleted_at", null);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
