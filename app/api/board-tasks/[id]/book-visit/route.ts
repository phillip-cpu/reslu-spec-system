import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { computeInsuranceStatus, insuranceWarningForBooking } from "@/lib/insurance";
import { rollupPhaseDatesForGroup } from "@/lib/phase-rollup";
import { queueTradeCalendarSync } from "@/lib/trade-calendar-sync";
import { sendOrQueue } from "@/lib/visit-emails";
import { formatArrival } from "@/lib/trade-visits";
import { hasAnyDocumentPackChoice, documentPackMentionLine } from "@/lib/trade-doc-pack";
import type { BookVisitInput } from "@/types/board-cockpit";
import type { BookVisitEmailSkipReason } from "@/types/board-v3-3";
import type { DocumentPackChoices } from "@/types/trade-doc-pack";

export const runtime = "nodejs";

const VALID_SLOTS = new Set(["first_thing", "midday", "afternoon"]);

/**
 * Board v3.3 — item 2 "Booking sends the request immediately": composes
 * and sends the trade's confirmation email the moment a visit is
 * booked from a card, instead of the trade hearing nothing until the
 * day-before cron (GET /api/trade-reminders) or a manual re-send. Same
 * subject/tone/link shape as POST /api/visits/[id]/resend-confirmation
 * copies from trade-reminders' own template (see that route's own
 * "STATE-MACHINE FINDING" doc comment for the full history of why THAT
 * was the nearest existing template to reuse) — this is the SAME reuse,
 * one level earlier in the lifecycle (at creation, not at a later
 * date-change). Deliberately its own small helper (not inlined into
 * POST below, which is already long) so the "existing_visit_id" link
 * path can call it too — a linked visit is just as freshly-booked-onto-
 * this-card as a newly-created one, and the trade may never have heard
 * about it either (e.g. it was created from the Timeline moments ago
 * with no send of its own — see resend-confirmation's finding that
 * visit CREATION has never sent anything).
 *
 * Returns `{ sent: true }` on an actual send, or `{ sent: false, reason }`
 * for every no-op case — never throws for a "nothing to send"/"nothing
 * to send YET" reason (no Resend config / no contact / contact has no
 * email / queued outside the send window / duplicate), only a genuine
 * send exception propagates, which the caller catches (fire-and-forget,
 * per this codebase's "the booking write is the source of truth, the
 * email is best-effort" discipline — same as every other trade-visit
 * email send site). See this function's own r27 item 13 comment
 * immediately below for the sendOrQueue routing this round added.
 *
 * "Trade booking document pack" round: when `hasDocumentPack` is true
 * (the booking's document_pack has at least one of the three choices
 * ticked — see this route's POST handler for exactly how that's
 * decided), one extra warm, brief line is appended mentioning that
 * plans/schedule/SOW are on the booking page — see this file's own
 * `documentPackMentionLine` helper below, shared by this email AND
 * resend-confirmation/trade-reminders so the three templates never
 * drift on wording.
 *
 * QA fix round (r27) item 13 — was a raw lib/gmail/send.ts
 * sendTeamEmail() call (no dedupe, no send window, no email_sends
 * log — this route's booking WRITE was logged nowhere near as
 * carefully as its EMAIL was). Now routes through lib/visit-emails.ts's
 * sendOrQueue — the exact dedupe/window/email_sends-logging machinery
 * every other trade/lead visit email in this codebase already gets.
 * SAME content, SAME sender identity (sendTeamEmail's own SENDER
 * constant was "RESLU <aria@reslu.com.au>" — the literal same mailbox
 * sendOrQueue's RESEND_FROM already sends everything else from, just a
 * different transport/display-name string): the plain-text booking
 * message below is unchanged; it's now delivered as sendOrQueue's
 * generic trade-booking-reply.html shell ({{company}}/{{message}}/
 * {{request_link}} — the same "message + view your dates" template
 * this round's item 2 fix (accept_shift branch, POST /api/trade-
 * requests/[id]/lines/[visitId]/resolve) already reuses for an
 * ad-hoc one-off trade notification) rather than a raw-text Gmail
 * message, since sendOrQueue only ever renders one of the four fixed
 * VisitEmailTemplateName HTML files — there is no "plaintext" option,
 * and this is the closest existing template to what was being sent
 * before (a short note + a link, trade-facing, no fixed visit-date
 * placeholders of its own).
 *
 * record_type is 'trade_booking_request' even though a single-visit
 * (r15) booking has no real trade_booking_requests row behind it — see
 * migration 054's own "keep it minimal, item 7 only" scope for this
 * round; there is no email_sends.record_type value that describes "a
 * single trade_visits row" and widening that CHECK constraint is out
 * of this round's one-migration budget. record_id is the trade_visits
 * row's own id (never a real trade_booking_requests.id), which keeps
 * the dedupe guard (record_type, record_id, template) correctly scoped
 * to just this one visit — it can never collide with a real r20
 * grouped-request row's own email_sends history (those always use a
 * genuine trade_booking_requests.id as record_id). Documented deviation,
 * not a silent misuse.
 */
async function sendBookingConfirmationEmail(
  supabase: SupabaseClient,
  params: {
    visitId: string;
    contactEmail: string | null;
    contactCompany: string | null;
    projectName: string;
    phaseName: string;
    startDate: string;
    endDate: string;
    arrivalSlot: string | null;
    arrivalTime: string | null;
    confirmToken: string;
    hasDocumentPack: boolean;
  }
): Promise<{ sent: true } | { sent: false; reason: BookVisitEmailSkipReason }> {
  if (!params.contactEmail) {
    // Distinguish "no contact linked at all" from "contact has no email
    // on file" for the UI's skip-reason copy — both are surfaced
    // identically upstream today (no contact_id vs. a contact with a
    // null email column), so this helper is only ever called when SOME
    // contact_id was supplied; see the two call sites below for how
    // each maps to a reason before even calling this helper.
    return { sent: false, reason: "no_contact_email" };
  }
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://spec.reslu.com.au";
  const tradeLink = `${appUrl}/trade/${params.confirmToken}`;
  const subject = `RESLU · site booking — ${params.projectName}: ${params.phaseName} ${params.startDate}`;
  const message = [
    `You've been booked for a site visit:`,
    `${params.startDate}${params.endDate !== params.startDate ? ` → ${params.endDate}` : ""} — ${formatArrival(params.arrivalSlot as "first_thing" | "midday" | "afternoon" | null, params.arrivalTime)}`,
    "",
    `Please confirm this date, or let us know if it doesn't work.`,
    ...(params.hasDocumentPack ? ["", documentPackMentionLine()] : []),
  ].join("\n");

  const result = await sendOrQueue(supabase, {
    recordType: "trade_booking_request",
    recordId: params.visitId,
    template: "trade-booking-reply",
    to: [params.contactEmail],
    subject,
    mergeData: { company: params.contactCompany, message, request_link: tradeLink },
    visitDatetime: params.startDate,
  });

  if (result.action === "sent") return { sent: true };
  if (result.action === "queued") return { sent: false, reason: "queued" };
  if (result.action === "duplicate") return { sent: false, reason: "duplicate" };
  // 'skipped' — either RESEND_API_KEY isn't set (result.reason ===
  // "no RESEND_API_KEY" per lib/resend.ts's isResendConfigured() guard,
  // the direct successor to the old isGmailConfigured() check this
  // route used to make up front) or the template failed to load.
  return { sent: false, reason: "no_resend_config" };
}

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
 *
 * Board v3.3 — item 2 "Booking actually sends": on success, this route
 * now ALSO sends the trade's confirmation email immediately (see
 * sendBookingConfirmationEmail above) — the day-before cron (GET
 * /api/trade-reminders) is left completely unchanged and still fires
 * for this visit 1-2 days before start_date, gated by its own existing
 * `reminder_sent_at IS NULL` filter, which this route does NOT stamp
 * (deliberately — that column stays null so the cron still treats this
 * as a fresh, never-reminded visit). This means a visit booked far in
 * advance gets TWO touches: this immediate email, then the day-before
 * reminder as a second nudge — an accepted, documented behaviour
 * (BUILD-SPEC.md's own item 2: "decide: cron still sends a reminder if
 * booked far in advance — yes, keep day-before reminder as a second
 * touch"). The one edge case worth naming: a visit booked TODAY for
 * tomorrow or the day after falls inside the cron's own 1-2-day window
 * and would also get the reminder on its very next run — accepted as
 * harmless per the same "second touch" reasoning (a trade booked with
 * 24-48 hours' notice hearing about it twice on the same day is not a
 * real problem worth extra gating logic for). Response gains
 * `email_sent` (boolean) and `email_skip_reason` (present only when
 * `email_sent` is false — "no_gmail_config" / "no_contact" /
 * "no_contact_email") so BookVisitPanel/the card badge can show
 * "request sent to {contact}" vs. "booked — email not sent: {reason}"
 * without a second round-trip. Best-effort: the email send is
 * fire-and-forget (logged, not thrown) — the booking write above
 * already committed and must never be rolled back over a notification
 * failure, same discipline every other trade-visit email send site in
 * this codebase already follows (resend-confirmation, trade-reminders).
 *
 * "Trade booking document pack" round (8 July 2026): body gains an
 * optional `document_pack` (types/trade-doc-pack.ts's
 * DocumentPackChoices) — BookVisitPanel's frozen "Include documents"
 * choices, stored verbatim onto the trade_visits row (migration
 * 032_visit_document_pack.sql's document_pack column) in the SAME
 * insert/update as the rest of the booking, never a second write. This
 * applies on BOTH branches below (a brand-new visit AND
 * existing_visit_id) — a re-linked visit is just as valid a place to
 * configure a pack as a freshly created one, and the panel's own
 * "Include documents" section renders identically regardless of which
 * branch the booking takes (see BookVisitPanel.tsx). Omitted entirely
 * from the body (not `null`) leaves document_pack at its column
 * default (null) for a new visit, and LEAVES AN EXISTING VISIT'S PACK
 * UNTOUCHED when linking to one that already has a pack from a prior
 * booking — the update below only ever includes document_pack in its
 * payload when the body actually supplied one, so relinking a card to
 * an existing, already-packed visit can never silently blank out a
 * pack nobody asked to change.
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
    .select("id,title,project_id,visit_id")
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

  let body: BookVisitInput & { document_pack?: DocumentPackChoices };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // "Trade booking document pack" round — only ever forwarded onto a
  // trade_visits write when the caller actually supplied it (see this
  // route's own doc comment above for why an omitted document_pack
  // must never blank out an existing pack on the existing_visit_id
  // link path). No shape validation beyond "is it present" — the
  // panel is this field's only writer today and always sends a
  // well-formed DocumentPackChoices object or omits the key entirely;
  // a malformed value would simply fail to render sensibly on the
  // trade page later rather than corrupt anything else here.
  const documentPack = body.document_pack;

  let visitId: string;
  let bookingStart: string;
  let bookingEnd: string;
  let insurance_warning: string | null = null;
  // Board v3.3 — item 2: everything sendBookingConfirmationEmail needs,
  // captured from WHICHEVER branch below actually runs (a brand new
  // visit, or a link to an existing one) so the send-after-write block
  // near the bottom of this route doesn't care which path was taken.
  let visitPhaseId: string;
  let visitContactId: string | null;
  let visitArrivalSlot: string | null = null;
  let visitArrivalTime: string | null = null;
  let visitConfirmToken: string;
  // "Trade booking document pack" — whichever pack ends up ACTUALLY
  // attached to this visit once this branch finishes, used only to
  // decide whether the confirmation email below mentions it (see
  // documentPackMentionLine's own doc comment for why the mention's
  // wording never varies by which of the three choices is set) — never
  // used to build the trade_visits write itself, which is handled
  // separately per branch above.
  let effectiveDocumentPack: DocumentPackChoices | null = documentPack ?? null;

  if ("existing_visit_id" in body) {
    const { data: existingVisit } = await supabase
      .from("trade_visits")
      .select("id,project_id,phase_id,contact_id,start_date,end_date,arrival_slot,arrival_time,confirm_token,document_pack")
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
    visitPhaseId = existingVisit.phase_id;
    visitContactId = existingVisit.contact_id;
    visitArrivalSlot = existingVisit.arrival_slot;
    visitArrivalTime = existingVisit.arrival_time;
    visitConfirmToken = existingVisit.confirm_token;

    // "Trade booking document pack" — a separate, explicit write (not
    // folded into the board_tasks update below, which touches
    // board_tasks not trade_visits) ONLY when the caller actually
    // supplied a pack — see this route's own doc comment for why an
    // omitted document_pack must never blank out a pack this visit
    // already had from a prior booking. effectiveDocumentPack falls
    // back to the visit's EXISTING pack (if any) when the caller
    // supplied none, so the email mention below still fires correctly
    // for a visit that already had a pack from an earlier booking.
    if (documentPack) {
      await supabase.from("trade_visits").update({ document_pack: documentPack }).eq("id", visitId);
    } else {
      effectiveDocumentPack = (existingVisit.document_pack as DocumentPackChoices | null) ?? null;
    }
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
        // "Trade booking document pack" — frozen at creation time,
        // straight from BookVisitPanel's "Include documents" section.
        // `|| null` (not `?? null`) is deliberate here even though
        // documentPack is already `T | undefined`: it mirrors every
        // other optional field in this exact insert (arrival_slot,
        // arrival_time, notes all use the same `|| null` fallback
        // style), for a single consistent idiom across this one insert
        // call rather than mixing `??` and `||`.
        document_pack: documentPack || null,
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
    visitPhaseId = newVisit.phase_id;
    visitContactId = newVisit.contact_id;
    visitArrivalSlot = newVisit.arrival_slot;
    visitArrivalTime = newVisit.arrival_time;
    visitConfirmToken = newVisit.confirm_token;
  }

  const { data: updatedTask, error: updateError } = await supabase
    .from("board_tasks")
    .update({
      visit_id: visitId,
      booking_date: bookingStart,
      booking_end_date: bookingEnd,
      due_date: null,
      due_time: null,
    })
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

  try {
    await queueTradeCalendarSync(supabase, {
      visit_id: visitId,
      project_id: task.project_id,
      contact_id: visitContactId,
      title: task.title,
      start_date: bookingStart,
      end_date: bookingEnd,
      arrival_slot: visitArrivalSlot,
      arrival_time: visitArrivalTime,
    });
  } catch (calendarError) {
    console.error("book-visit POST: could not queue RESLU calendar sync", calendarError);
  }

  // Board v3.3 — item 2: send the trade's confirmation email now,
  // immediately, rather than leaving the trade to hear nothing until
  // the day-before cron (see this route's own doc comment above for
  // the full cron-interaction rationale). `email_sent`/
  // `email_skip_reason` always both resolve to a definite value below
  // (never left undefined-by-omission) so the client never has to
  // guess at a missing field's meaning.
  let email_sent = false;
  let email_skip_reason: BookVisitEmailSkipReason | undefined;
  if (!visitContactId) {
    email_skip_reason = "no_contact";
  } else {
    try {
      const [{ data: phase }, { data: project }, { data: contact }] = await Promise.all([
        supabase.from("schedule_phases").select("name").eq("id", visitPhaseId).maybeSingle(),
        supabase.from("projects").select("name").eq("id", task.project_id).maybeSingle(),
        supabase.from("contacts").select("email,company").eq("id", visitContactId).maybeSingle(),
      ]);
      const outcome = await sendBookingConfirmationEmail(supabase, {
        visitId,
        contactEmail: contact?.email ?? null,
        contactCompany: contact?.company ?? null,
        projectName: project?.name ?? "Project",
        phaseName: phase?.name ?? "Visit",
        startDate: bookingStart,
        endDate: bookingEnd,
        arrivalSlot: visitArrivalSlot,
        arrivalTime: visitArrivalTime,
        confirmToken: visitConfirmToken,
        hasDocumentPack: hasAnyDocumentPackChoice(effectiveDocumentPack),
      });
      if (outcome.sent) {
        email_sent = true;
      } else {
        email_skip_reason = outcome.reason;
      }
    } catch (emailError) {
      console.error("book-visit POST: booking confirmation email send failed", emailError);
      // Fire-and-forget — the booking itself has already committed
      // above; email_sent stays false with no more specific reason than
      // this generic fallback (a real send exception, not a
      // config/contact/window/dedupe skip, which sendOrQueue itself
      // already handles without throwing).
      email_skip_reason = "send_failed";
    }
  }

  return NextResponse.json(
    { task: updatedTask, insurance_warning, email_sent, email_skip_reason },
    { status: 201 }
  );
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
