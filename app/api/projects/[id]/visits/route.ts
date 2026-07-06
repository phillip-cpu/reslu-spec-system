import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { CreateVisitInput, ArrivalSlot } from "@/lib/trade-visits";
import { computeInsuranceStatus, insuranceWarningForBooking } from "@/lib/insurance";

const VALID_SLOTS = new Set<ArrivalSlot>(["first_thing", "midday", "afternoon"]);

/**
 * POST /api/projects/[id]/visits
 * Team session (no admin gate — scheduling data, not financial, same
 * reasoning as the phases routes). Body: CreateVisitInput —
 * { phase_id, contact_id?, start_date, end_date, arrival_slot?,
 * arrival_time?, notes? }.
 *
 * Validates: phase exists under this project and is NOT kind
 * 'umbrella' (400 — the umbrella band has no real-world visits, it's
 * a system-derived summary band), contact (if given) exists,
 * end_date >= start_date, arrival_slot enum if present. Inserts with
 * status='unconfirmed' — confirm_token is a DB default (migration
 * 015), never client-supplied. Response: { visit, insurance_warning }
 * (201).
 *
 * Fix Round A — Trade insurance tracker: insurance_warning is
 * lib/insurance.ts's insuranceWarningForBooking() result for the
 * booked contact's CURRENT insurance_status (null when there's no
 * contact, or the contact's insurance is current/expiring-but-not-yet-
 * expired). Purely advisory — never blocks the booking, per
 * BUILD-SPEC.md "creating/confirming a visit for a contact with
 * expired/missing insurance shows a warning (non-blocking)". The
 * booking UI (components/gantt/VisitBottomSheet.tsx's AddVisitForm)
 * surfaces this string non-blockingly after a successful create.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: CreateVisitInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

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
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .maybeSingle();

  if (!phase) {
    return NextResponse.json({ error: "Phase not found" }, { status: 404 });
  }
  if (phase.kind === "umbrella") {
    return NextResponse.json(
      { error: "Cannot add visits to the Site Setup umbrella phase" },
      { status: 400 }
    );
  }

  // Fix Round A — Trade insurance tracker booking warning
  // (BUILD-SPEC.md: "creating/confirming a visit for a contact with
  // expired/missing insurance shows a warning (non-blocking) in the
  // booking UI + API response flag"). Computed BEFORE the insert so a
  // contact lookup failure never blocks the actual booking — this is
  // advisory only, never a validation error.
  let insurance_warning: string | null = null;
  if (body.contact_id) {
    const { data: contact } = await supabase
      .from("contacts")
      .select("id,category")
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
    const status = computeInsuranceStatus(contact.category, documents ?? []);
    insurance_warning = insuranceWarningForBooking(status);
  }

  const { data: visit, error } = await supabase
    .from("trade_visits")
    .insert({
      project_id: projectId,
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

  if (error) {
    const status = error.code === "23503" || error.code === "23514" ? 400 : 500;
    return NextResponse.json({ error: error.message }, { status });
  }

  return NextResponse.json({ visit, insurance_warning }, { status: 201 });
}
