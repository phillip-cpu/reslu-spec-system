import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { sendOrQueue } from "@/lib/visit-emails";
import { buildTaskRowsHtml } from "@/lib/trade-booking";
import { documentPackMentionLine } from "@/lib/trade-doc-pack";
import type { DocumentPackChoices } from "@/types/trade-doc-pack";

export const runtime = "nodejs";

const DUPLICATE_GUARD_MS = 2 * 60 * 1000;

/**
 * POST /api/trade-requests/[id]/resend
 *
 * Grouped trade booking round (r20) — BUILD-SPEC.md item 6: "No
 * response after 3 days -> follow-up flag on the request (surfaces in
 * My Work follow-ups), re-send option (same token, SEQUENCE-style
 * resend guard in email_sends)." Surfaced from the My Work follow-up
 * item (source #11, GET /api/my-work) and the admin request detail
 * view. Only valid while status = 'sent' (still fully awaiting the
 * trade — a request that's moved to 'responded'/'closed' has nothing
 * left this action makes sense for; 'draft' is never resendable since
 * it was never sent in the first place).
 *
 * SAME TOKEN — this re-sends `trade-booking-request` against the
 * request's own unchanged `token` (no new row, no new link minted),
 * only re-listing lines still `line_status = 'proposed'` (an already-
 * accepted/date-suggested line has nothing left to chase — partial
 * responses are allowed per item 3, and a resend should only nudge on
 * what's still outstanding).
 *
 * Duplicate-send guard: claim_trade_request_resend() (migration 049)
 * atomically claims the right to resend before any email is attempted
 * — rejects (429) if a claim was already made within the last two
 * minutes. Single UPDATE ... RETURNING under the hood, so two near-
 * simultaneous resend clicks can't both pass the check the way a
 * plain select-then-send would (sendOrQueue's own dedupe, keyed on
 * visit_datetime, can't apply here — there's no single "visit
 * datetime" for a grouped request — see that route's own doc comment).
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

  const { data: bookingRequest } = await supabase
    .from("trade_booking_requests")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!bookingRequest) {
    return NextResponse.json({ error: "Request not found" }, { status: 404 });
  }
  if (bookingRequest.status !== "sent") {
    return NextResponse.json(
      { error: "Only a request still awaiting a response ('sent') can be resent." },
      { status: 400 }
    );
  }

  const { data: claimed, error: claimError } = await supabase.rpc("claim_trade_request_resend", {
    p_request_id: id,
    p_guard_ms: DUPLICATE_GUARD_MS,
  });
  if (claimError) {
    return NextResponse.json({ error: claimError.message }, { status: 500 });
  }
  if (!claimed) {
    return NextResponse.json({ error: "This request was just resent — please wait a moment." }, { status: 429 });
  }

  const [{ data: project }, { data: contact }, { data: visits }] = await Promise.all([
    supabase.from("projects").select("id,name,address").eq("id", bookingRequest.project_id).maybeSingle(),
    bookingRequest.contact_id
      ? supabase.from("contacts").select("id,company,email").eq("id", bookingRequest.contact_id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from("trade_visits")
      .select("id,start_date,end_date,line_status,document_pack")
      .eq("booking_request_id", id)
      .eq("line_status", "proposed")
      .is("deleted_at", null),
  ]);

  if (!project || !contact) {
    return NextResponse.json({ error: "Request's project or contact no longer exists." }, { status: 400 });
  }
  const outstandingVisits = visits ?? [];
  if (outstandingVisits.length === 0) {
    return NextResponse.json(
      { error: "Every line has already been responded to — nothing left to resend." },
      { status: 400 }
    );
  }
  if (!contact.email) {
    return NextResponse.json({ error: "This contact has no email on file." }, { status: 400 });
  }

  const visitIds = outstandingVisits.map((v) => v.id);
  const { data: linkedTasks } = await supabase
    .from("board_tasks")
    .select("id,title,visit_id")
    .in("visit_id", visitIds)
    .is("deleted_at", null);
  const taskByVisitId = new Map((linkedTasks ?? []).map((t) => [t.visit_id, t]));

  const emailLines = outstandingVisits.map((v) => ({
    task_title: taskByVisitId.get(v.id)?.title ?? "Task",
    start_date: v.start_date,
    end_date: v.end_date,
  }));
  const pack = (outstandingVisits[0]?.document_pack ?? null) as DocumentPackChoices | null;
  const hasPack = pack ? pack.include_plans || pack.include_sow || "schedule_categories" in pack : false;

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://spec.reslu.com.au";
  const requestLink = `${appUrl}/trade-request/${bookingRequest.token}`;

  const result = await sendOrQueue(supabase, {
    recordType: "trade_booking_request",
    recordId: id,
    template: "trade-booking-request",
    to: [contact.email],
    subject: `RESLU · site visit dates — ${project.name} (follow-up)`,
    mergeData: {
      company: contact.company,
      project_name: project.name,
      project_address: project.address ?? "",
      task_rows: buildTaskRowsHtml(emailLines),
      request_link: requestLink,
      attachments_note: hasPack ? documentPackMentionLine() : "",
    },
    // A resend is, by construction, always a fresh instant — using
    // `now` (rather than the original sent_at) means sendOrQueue's own
    // dedupe never blocks this deliberate, explicitly-guarded resend
    // (see this route's own duplicate-guard above, which is the real
    // idempotency check for this call site).
    visitDatetime: new Date().toISOString(),
  });

  return NextResponse.json({
    email_sent: result.action === "sent",
    email_skip_reason: result.action === "sent" ? undefined : result.reason,
  });
}
