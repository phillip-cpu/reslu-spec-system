import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { computeInsuranceStatus, insuranceWarningForBooking } from "@/lib/insurance";
import { rollupPhaseDatesForGroup } from "@/lib/phase-rollup";
import type { BookVisitInput } from "@/types/board-cockpit";

export const runtime = "nodejs";

const VALID_SLOTS = new Set(["first_thing", "midday", "afternoon"]);

/**
 * POST /api/board-tasks/[id]/book-visit
 * Board cockpit round (7 July 2026) — "Book-trade-from-card with
 * visit_id linkage + live status badge." Books a trade visit directly
 * from a board card, without leaving the Board for the Timeline tab.
 * Body: BookVisitInput — EITHER { phase_id, start_date, end_date,
 * contact_id?, arrival_slot?, arrival_time?, notes? } (creates a new
 * trade_visits row, same required fields as POST
 * /api/projects/[id]/visits) OR { existing_visit_id } (links the card
 * to an already-booked visit, e.g. one created from the Timeline for
 * the same trade). Sets board_tasks.visit_id AND denormalizes
 * booking_date/booking_end_date from the visit's own start_date/
 * end_date onto the card (see migration 029's board_tasks.booking_date
 * comment for why these are kept as synced copies rather than a live
 * join). Response: { task } — the full BoardTaskCockpit shape,
 * including the freshly-joined `visit` summary for the card's status
 * badge to render immediately without a second fetch.
 *
 * Validates: task exists (404), NOT already linked to a visit (400 —
 * unlink first via DELETE .../book-visit before rebooking; a card
 * only ever tracks one active booking at a time, same "one thing at a
 * time" discipline board_tasks.contact_id already has for its single
 * contact link); when creating a new visit, the phase belongs to the
 * same project as the card and is not kind='umbrella' (mirrors POST
 * /api/projects/[id]/visits's own checks exactly); when linking an
 * existing visit, it belongs to the same project and is not already
 * linked to a DIFFERENT card (a visit is 1:1 with at most one card,
 * enforced here at the app layer since migration 029 does not put a
 * unique constraint on board_tasks.visit_id — a unique constraint
 * would incorrectly forbid multiple NULLs... no, NULLs are fine under
 * a unique index; it is NOT added here purely because "one active
 * link at a time" is already enforced by this route's own explicit
 * check before insert, consistent with how every other single-link
 * invariant in this schema — e.g. board_groups.phase_id — is
 * app-enforced, not DB-unique-enforced, per this schema's established
 * "app layer enforces business invariants, DB enforces referential
 * integrity" split).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: task } = await supabase
    .from("board_tasks")
    .select("id,project_id,visit_id")
    .eq("id", taskId)
    .is("deleted_at", null)
    .single();
  if (!task) {
    return NextResponse.json({ error: "Card not found" }, { status: 404 });
  }
  if (task.visit_id) {
    return NextResponse.json(
      { error: "This card already has a booking linked — unlink it first." },
      { status: 400 }
    );
  }

  let body: BookVisitInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  let visitId: string;
  let bookingStart: string;
  let bookingEnd: string;
  let insurance_warning: string | null = null;

  if ("existing_visit_id" in body) {
    const { data: existingVisit } = await supabase
      .from("trade_visits")
      .select("id,project_id,start_date,end_date")
      .eq("id", body.existing_visit_id)
      .eq("project_id", task.project_id)
      .is("deleted_at", null)
      .maybeSingle();
    if (!existingVisit) {
      return NextResponse.json({ error: "Visit not found in this project" }, { status: 404 });
    }
    const { data: alreadyLinked } = await supabase
      .from("board_tasks")
      .select("id")
      .eq("visit_id", existingVisit.id)
      .is("deleted_at", null)
      .maybeSingle();
    if (alreadyLinked) {
      return NextResponse.json({ error: "That visit is already linked to another card" }, { status: 400 });
    }
    visitId = existingVisit.id;
    bookingStart = existingVisit.start_date;
    bookingEnd = existingVisit.end_date;
  } else {
    if (!body.phase_id || !body.start_date || !body.end_date) {
      return NextResponse.json(
        { error: "phase_id, start_date and end_date are required" },
        { status: 400 }
      );
    }
    if (body.end_date < body.start_date) {
      return NextResponse.json({ error: "end_date must be on or after start_date" }, { status: 400 });
    }
    if (body.arrival_slot && !VALID_SLOTS.has(body.arrival_slot)) {
      return NextResponse.json(
        { error: "arrival_slot must be one of first_thing, midday, afternoon" },
        { status: 400 }
      );
    }

    const { data: phase } = await supabase
      .from("schedule_phases")
      .select("id,project_id,kind")
      .eq("id", body.phase_id)
      .eq("project_id", task.project_id)
      .is("deleted_at", null)
      .maybeSingle();
    if (!phase) {
      return NextResponse.json({ error: "Phase not found" }, { status: 404 });
    }
    if (phase.kind === "umbrella") {
      return NextResponse.json(
        { error: "Cannot book a visit against the Site Setup umbrella phase" },
        { status: 400 }
      );
    }

    if (body.contact_id) {
      const { data: contact } = await supabase
        .from("contacts")
        .select("id,insurance_required")
        .eq("id", body.contact_id)
        .is("deleted_at", null)
        .maybeSingle();
      if (!contact) {
        return NextResponse.json({ error: "Contact not found" }, { status: 404 });
      }
      const { data: documents } = await supabase
        .from("contact_documents")
        .select("kind,expiry_date,deleted_at")
        .eq("contact_id", body.contact_id)
        .is("deleted_at", null);
      const status = computeInsuranceStatus(contact.insurance_required, documents ?? []);
      insurance_warning = insuranceWarningForBooking(status);
    }

    const { data: newVisit, error: visitError } = await supabase
      .from("trade_visits")
      .insert({
        project_id: task.project_id,
        phase_id: body.phase_id,
        contact_id: body.contact_id || null,
        start_date: body.start_date,
        end_date: body.end_date,
        arrival_slot: body.arrival_slot || null,
        arrival_time: body.arrival_time || null,
        notes: body.notes?.trim() || null,
        status: "unconfirmed",
        created_by: user.id,
      })
      .select()
      .single();

    if (visitError || !newVisit) {
      const status = visitError?.code === "23503" || visitError?.code === "23514" ? 400 : 500;
      return NextResponse.json({ error: visitError?.message ?? "Could not create visit" }, { status });
    }
    visitId = newVisit.id;
    bookingStart = newVisit.start_date;
    bookingEnd = newVisit.end_date;
  }

  const { data: updatedTask, error: updateError } = await supabase
    .from("board_tasks")
    .update({ visit_id: visitId, booking_date: bookingStart, booking_end_date: bookingEnd })
    .eq("id", taskId)
    .select()
    .single();

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  // INVARIANT: schedule_phases.start_date/end_date are derived from the
  // min/max works dates (board_tasks.booking_date/booking_end_date) of
  // tasks in groups linked to this phase, whenever any linked task has
  // works dates set. This keeps Timeline (lib/gantt.ts) consistent with
  // the board's grouped-list rollup display. Best-effort: a rollup
  // failure must never fail this booking request, which already
  // succeeded above — log and swallow.
  try {
    await rollupPhaseDatesForGroup(supabase, updatedTask.phase_group_id);
  } catch (rollupError) {
    console.error("rollupPhaseDatesForGroup failed after book-visit POST:", rollupError);
  }

  return NextResponse.json({ task: updatedTask, insurance_warning }, { status: 201 });
}

/**
 * DELETE /api/board-tasks/[id]/book-visit
 * Unlinks a card's booking (clears visit_id/booking_date/
 * booking_end_date) WITHOUT deleting the underlying trade_visits row —
 * the visit itself may still be a real, live booking on the Timeline;
 * this only removes the card's link to it, matching board_groups'
 * "delete the group, cards keep their status but lose the phase label"
 * precedent (app/api/board-groups/[id]/route.ts) for "removing a link
 * never cascades to delete the thing it pointed at."
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: task, error } = await supabase
    .from("board_tasks")
    .update({ visit_id: null, booking_date: null, booking_end_date: null })
    .eq("id", taskId)
    .is("deleted_at", null)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!task) {
    return NextResponse.json({ error: "Card not found" }, { status: 404 });
  }

  // INVARIANT: schedule_phases.start_date/end_date are derived from the
  // min/max works dates (board_tasks.booking_date/booking_end_date) of
  // tasks in groups linked to this phase, whenever any linked task has
  // works dates set. This keeps Timeline (lib/gantt.ts) consistent with
  // the board's grouped-list rollup display. Best-effort: a rollup
  // failure must never fail this unlink request, which already
  // succeeded above — log and swallow.
  try {
    await rollupPhaseDatesForGroup(supabase, task.phase_group_id);
  } catch (rollupError) {
    console.error("rollupPhaseDatesForGroup failed after book-visit DELETE:", rollupError);
  }

  return NextResponse.json({ task });
}
