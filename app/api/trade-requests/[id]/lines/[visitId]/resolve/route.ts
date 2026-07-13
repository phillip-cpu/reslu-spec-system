import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { rollupPhaseDatesForGroup } from "@/lib/phase-rollup";
import { sendOrQueue } from "@/lib/visit-emails";
import { computeShiftDeltaDays } from "@/lib/trade-booking";
import { closeBriefItem } from "@/lib/daily-brief-close";
import type { ResolveTradeLineInput, ResolveTradeLineResponse, TradeBookingRequestLine } from "@/types/round-grouped-trade-booking";

export const runtime = "nodejs";

/**
 * POST /api/trade-requests/[id]/lines/[visitId]/resolve
 *
 * Grouped trade booking round (r20) — the two admin actions on a
 * 'date_suggested' line (BUILD-SPEC.md item 5):
 *
 * - 'accept_shift': applies the trade's suggested_start/suggested_end
 *   onto the line itself (line_status -> 'accepted', status ->
 *   'confirmed', confirmed_by 'staff' — same existing-status reuse as
 *   the trade's own 'accept' action on /trade-request/[token]),
 *   syncs the linked board_task's booking_date/booking_end_date to
 *   match (same denormalised-sync discipline every other visit-date
 *   write path in this codebase already follows), then OFFERS (never
 *   applies) the existing POST /api/phases/[id]/shift-items ripple for
 *   the rest of that phase's tasks, via `shift_offer` in the response
 *   — this route never calls shift-items itself, the ADMIN UI does, on
 *   a separate explicit click, reusing that route entirely unchanged
 *   (BUILD-SPEC.md: "do NOT reimplement ripple math").
 *
 * - 'keep_reply': frees the line back to line_status 'proposed'
 *   (clearing suggested_start/end/response_note — the original dates
 *   stand), and optionally sends a short reply email (same
 *   trade_booking_request send machinery, template
 *   'trade-booking-reply', logged in email_sends).
 *
 * Idempotent (double-POST safe): a line already 'accepted' returns its
 * current state with `shift_offer: null` rather than re-applying
 * (suggested_start/end are already cleared by the first call, so a
 * naive re-apply would silently null the dates out); a line already
 * back at 'proposed' (keep_reply already ran) returns current state
 * without re-sending the reply email.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; visitId: string }> }
) {
  const { id: requestId, visitId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: bookingRequest } = await supabase
    .from("trade_booking_requests")
    .select("*")
    .eq("id", requestId)
    .maybeSingle();
  if (!bookingRequest) {
    return NextResponse.json({ error: "Request not found" }, { status: 404 });
  }

  const { data: visit } = await supabase
    .from("trade_visits")
    .select("*")
    .eq("id", visitId)
    .eq("booking_request_id", requestId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!visit) {
    return NextResponse.json({ error: "Line not found on this request" }, { status: 404 });
  }

  const { data: linkedTask } = await supabase
    .from("board_tasks")
    .select("id,title,phase_group_id")
    .eq("visit_id", visitId)
    .is("deleted_at", null)
    .maybeSingle();

  let body: ResolveTradeLineInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  async function currentLine(): Promise<TradeBookingRequestLine> {
    const { data: fresh } = await supabase.from("trade_visits").select("*").eq("id", visitId).single();
    const { data: phase } = await supabase.from("schedule_phases").select("name").eq("id", fresh.phase_id).maybeSingle();
    return {
      id: fresh.id,
      task_id: linkedTask?.id ?? null,
      task_title: linkedTask?.title ?? "(unlinked task)",
      phase_id: fresh.phase_id,
      phase_name: phase?.name ?? "Phase",
      start_date: fresh.start_date,
      end_date: fresh.end_date,
      status: fresh.status,
      line_status: (fresh.line_status as TradeBookingRequestLine["line_status"]) ?? "proposed",
      suggested_start: fresh.suggested_start,
      suggested_end: fresh.suggested_end,
      response_note: fresh.response_note,
    };
  }

  if (body.action === "accept_shift") {
    if (visit.line_status === "accepted") {
      // Idempotent no-op — see this route's own doc comment.
      const line = await currentLine();
      return NextResponse.json({ line, shift_offer: null } as ResolveTradeLineResponse);
    }
    if (visit.line_status !== "date_suggested" || !visit.suggested_start || !visit.suggested_end) {
      return NextResponse.json({ error: "This line has no suggested date to accept." }, { status: 400 });
    }

    const oldStart = visit.start_date;
    const { error: updateError } = await supabase
      .from("trade_visits")
      .update({
        start_date: visit.suggested_start,
        end_date: visit.suggested_end,
        line_status: "accepted",
        status: "confirmed",
        confirmed_at: new Date().toISOString(),
        confirmed_by: "staff",
        suggested_start: null,
        suggested_end: null,
      })
      .eq("id", visitId);
    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }

    // BUILD-SPEC.md r27 item 10 — Daily Brief self-close. The trade's
    // suggestion is what raised the attention item in the first place
    // (POST /api/trade-request/[token]/respond's 'suggest' branch,
    // source='trade', link_href `/trade-requests/{requestId}?focus=
    // line-{visitId}` — see that route's own insert). Accepting the
    // shift is a genuine resolution of that suggestion, so close it;
    // link_href already uniquely keys this one line, no title match
    // needed. Best-effort (closeBriefItem never throws) — never blocks
    // the accept itself, which already committed above.
    await closeBriefItem(supabase, "trade", `/trade-requests/${requestId}?focus=line-${visitId}`);

    let shiftOffer: ResolveTradeLineResponse["shift_offer"] = null;
    if (linkedTask) {
      await supabase
        .from("board_tasks")
        .update({ booking_date: visit.suggested_start, booking_end_date: visit.suggested_end })
        .eq("id", linkedTask.id);
      try {
        await rollupPhaseDatesForGroup(supabase, linkedTask.phase_group_id);
      } catch (rollupError) {
        console.error("trade-requests resolve: rollupPhaseDatesForGroup failed", rollupError);
      }

      const deltaDays = computeShiftDeltaDays(oldStart, visit.suggested_start);
      if (deltaDays !== 0 && linkedTask.phase_group_id) {
        const { data: siblingTasks } = await supabase
          .from("board_tasks")
          .select("id")
          .eq("phase_group_id", linkedTask.phase_group_id)
          .neq("id", linkedTask.id)
          .not("booking_date", "is", null)
          .is("deleted_at", null)
          .limit(1);
        if ((siblingTasks ?? []).length > 0) {
          shiftOffer = { phase_id: visit.phase_id, delta_days: deltaDays };
        }
      }
    }

    // BUILD-SPEC.md r27 item 2 — the trade never heard back once Phillip
    // accepted THEIR counter-date: this branch updated the line/board_task
    // silently and just offered the shift-items ripple to the admin. Send
    // a short confirmation, mirroring the keep_reply branch's send exactly
    // (same template/transport/log — trade-booking-reply.html is generic
    // "message + view your dates", not reply-specific despite the name).
    let email_sent = false;
    let email_skip_reason: string | undefined;
    const { data: acceptContact } = bookingRequest.contact_id
      ? await supabase.from("contacts").select("id,company,email").eq("id", bookingRequest.contact_id).maybeSingle()
      : { data: null };
    if (!acceptContact?.email) {
      email_skip_reason = "No recipient email on file";
    } else {
      const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://spec.reslu.com.au";
      const requestLink = `${appUrl}/trade-request/${bookingRequest.token}`;
      const confirmedMessage = `Confirmed — we've locked in ${visit.suggested_start} for ${linkedTask?.title ?? "this task"}. Thanks for letting us know.`;
      const result = await sendOrQueue(supabase, {
        recordType: "trade_booking_request",
        recordId: requestId,
        template: "trade-booking-reply",
        to: [acceptContact.email],
        subject: `RESLU · confirmed: ${linkedTask?.title ?? "your site visit dates"}`,
        mergeData: { company: acceptContact.company, message: confirmedMessage, request_link: requestLink },
        visitDatetime: new Date().toISOString(),
      });
      email_sent = result.action === "sent";
      if (!email_sent) email_skip_reason = result.reason;
    }

    const line = await currentLine();
    return NextResponse.json({ line, shift_offer: shiftOffer, email_sent, email_skip_reason } as ResolveTradeLineResponse);
  }

  if (body.action === "keep_reply") {
    if (visit.line_status === "proposed") {
      // Idempotent no-op — already back to 'proposed', no second reply email.
      const line = await currentLine();
      return NextResponse.json({ line, shift_offer: null, email_sent: false } as ResolveTradeLineResponse);
    }
    if (visit.line_status !== "date_suggested") {
      return NextResponse.json({ error: "This line has nothing to reply to." }, { status: 400 });
    }

    const { error: updateError } = await supabase
      .from("trade_visits")
      .update({ line_status: "proposed", suggested_start: null, suggested_end: null, response_note: null })
      .eq("id", visitId);
    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }

    // BUILD-SPEC.md r27 item 10 — same self-close as the accept_shift
    // branch above: "keep original + reply" is the OTHER way of
    // resolving the trade's suggestion, so it closes the exact same
    // attention item.
    await closeBriefItem(supabase, "trade", `/trade-requests/${requestId}?focus=line-${visitId}`);

    let email_sent = false;
    let email_skip_reason: string | undefined;
    const { data: contact } = bookingRequest.contact_id
      ? await supabase.from("contacts").select("id,company,email").eq("id", bookingRequest.contact_id).maybeSingle()
      : { data: null };
    if (!contact?.email) {
      email_skip_reason = "No recipient email on file";
    } else {
      const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://spec.reslu.com.au";
      const requestLink = `${appUrl}/trade-request/${bookingRequest.token}`;
      const message =
        body.message?.trim() ||
        `Thanks for letting us know — we'd like to keep the original date for ${linkedTask?.title ?? "this task"}. Let us know if that still works.`;
      const result = await sendOrQueue(supabase, {
        recordType: "trade_booking_request",
        recordId: requestId,
        template: "trade-booking-reply",
        to: [contact.email],
        subject: `RESLU · re: ${linkedTask?.title ?? "your site visit dates"}`,
        mergeData: { company: contact.company, message, request_link: requestLink },
        visitDatetime: new Date().toISOString(),
      });
      email_sent = result.action === "sent";
      if (!email_sent) email_skip_reason = result.reason;
    }

    const line = await currentLine();
    return NextResponse.json({ line, shift_offer: null, email_sent, email_skip_reason } as ResolveTradeLineResponse);
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
