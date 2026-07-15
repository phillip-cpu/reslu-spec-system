import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { computeInsuranceStatus, insuranceWarningForBooking } from "@/lib/insurance";
import { queueTradeCalendarSync } from "@/lib/trade-calendar-sync";

/**
 * POST /api/visits/[id]/confirm
 * Staff "mark confirmed" — team session, no admin gate
 * (scheduling data, not financial, same reasoning as every other
 * phases/visits route). Sets status='confirmed', confirmed_at=now(),
 * confirmed_by='staff'. No body required. Response:
 * { visit, insurance_warning }.
 *
 * Used when RESLU receives confirmation directly (phone, in person or
 * otherwise) and needs to record it without pretending the trade used
 * the email response page.
 *
 * Fix Round A — Trade insurance tracker: insurance_warning mirrors
 * POST /api/projects/[id]/visits' same field — computed from the
 * visit's linked contact's CURRENT insurance_status at confirm time
 * (not the value from when the visit was first created, which may be
 * stale), null when there's no contact or insurance is fine.
 * Non-blocking — confirming still succeeds regardless.
 */
export async function POST(
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

  const { data: existing } = await supabase
    .from("trade_visits")
    .select("id,project_id,contact_id,booking_request_id,start_date,end_date,arrival_slot,arrival_time")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!existing) {
    return NextResponse.json({ error: "Visit not found" }, { status: 404 });
  }

  const confirmedAt = new Date().toISOString();
  const { data: visit, error } = await supabase
    .from("trade_visits")
    .update({
      status: "confirmed",
      ...(existing.booking_request_id
        ? {
            line_status: "accepted",
            suggested_start: null,
            suggested_end: null,
            response_note: null,
          }
        : {}),
      confirmed_at: confirmedAt,
      confirmed_by: "staff",
    })
    .eq("id", id)
    .is("deleted_at", null)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // A grouped request is complete once every line has a staff/trade
  // response. This mirrors the public response route, so My Work no
  // longer shows a follow-up after RESLU records the final direct
  // confirmation.
  if (existing.booking_request_id) {
    const { data: remaining } = await supabase
      .from("trade_visits")
      .select("id")
      .eq("booking_request_id", existing.booking_request_id)
      .eq("line_status", "proposed")
      .is("deleted_at", null)
      .limit(1);
    if ((remaining ?? []).length === 0) {
      await supabase
        .from("trade_booking_requests")
        .update({ status: "responded", responded_at: confirmedAt })
        .eq("id", existing.booking_request_id)
        .eq("status", "sent");
    }
  }

  // Booking itself is the source of truth for the reminder. Clearing
  // any linked board-card due date prevents a directly confirmed visit
  // continuing to appear as outstanding work.
  await supabase
    .from("board_tasks")
    .update({ due_date: null, due_time: null })
    .eq("visit_id", id)
    .is("deleted_at", null);

  let insurance_warning: string | null = null;
  if (existing.contact_id) {
    const { data: contact } = await supabase
      .from("contacts")
      .select("insurance_required")
      .eq("id", existing.contact_id)
      .maybeSingle();
    const { data: documents } = await supabase
      .from("contact_documents")
      .select("kind,expiry_date,deleted_at")
      .eq("contact_id", existing.contact_id)
      .is("deleted_at", null);
    const status = computeInsuranceStatus(contact?.insurance_required ?? false, documents ?? []);
    insurance_warning = insuranceWarningForBooking(status);
  }

  const [{ data: project }, { data: contact }] = await Promise.all([
    supabase.from("projects").select("name").eq("id", existing.project_id).maybeSingle(),
    existing.contact_id
      ? supabase.from("contacts").select("company").eq("id", existing.contact_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  let calendar_sync_queued = false;
  let calendar_warning: string | null = null;
  try {
    calendar_sync_queued = await queueTradeCalendarSync(supabase, {
      visit_id: existing.id,
      project_id: existing.project_id,
      contact_id: existing.contact_id,
      title: `${project?.name ?? "Project"} — ${contact?.company ?? "Trade visit"}`,
      start_date: existing.start_date,
      end_date: existing.end_date,
      arrival_slot: existing.arrival_slot,
      arrival_time: existing.arrival_time,
    });
  } catch (calendarError) {
    calendar_warning = calendarError instanceof Error ? calendarError.message : "Calendar sync could not be queued";
  }

  return NextResponse.json({ visit, insurance_warning, calendar_sync_queued, calendar_warning });
}
