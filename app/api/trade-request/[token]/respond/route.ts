import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/rate-limit";
import { isRequestFullyExpired } from "@/lib/trade-request";
import { allLinesResolved } from "@/lib/trade-booking";
import { sendPushToAdmins } from "@/lib/push";
import type { TradeRequestRespondInput } from "@/types/round-grouped-trade-booking";

export const runtime = "nodejs";

/**
 * POST /api/trade-request/[token]/respond
 *
 * Grouped trade booking round (r20) — public, unauthenticated,
 * token-gated (trade_booking_requests.token), same trust model/rate-
 * limit shape as POST /api/trade/[token]/respond (10/min, tighter than
 * the page GET's default). body: TradeRequestRespondInput, dispatched
 * on `action`:
 *
 * - 'accept': the named line (`line_id`, a trade_visits.id) moves to
 *   line_status='accepted', status='confirmed' (the EXISTING r15
 *   status enum — this is deliberate: once a grouped line is
 *   confirmed, it is indistinguishable from an ordinary r15 visit to
 *   every existing feature that reads `status` — the day-before
 *   reminder cron's `status in ('unconfirmed','tentative')` filter
 *   naturally stops considering it, "who else is on site" naturally
 *   includes it, etc. — see migration 049's own header comment for
 *   "existing confirmation email/reminder machinery per visit"). Valid
 *   from line_status 'proposed' OR 'date_suggested' (a trade can still
 *   accept the ORIGINAL date after having suggested something else —
 *   BUILD-SPEC.md's own "partial responses fine, accepted lines lock"
 *   wording never forbids this). IDEMPOTENT: re-POSTing 'accept' for an
 *   already-'accepted' line 200s with its current (unchanged) state
 *   rather than erroring — double-POST safe.
 *
 * - 'suggest': sets suggested_start/suggested_end/response_note,
 *   line_status='date_suggested'. Validates suggested_end >=
 *   suggested_start. Rejected (400) if the line is already 'accepted'
 *   (BUILD-SPEC.md: "accepted lines lock immediately" — reloading the
 *   page renders them locked, and a direct POST against a locked line
 *   is refused here too, same "re-check independently of the page
 *   component" discipline as every other tokened respond route in this
 *   codebase). BUILD-SPEC.md item 4/"Suggestions never move the
 *   board": this action NEVER touches start_date/end_date/status —
 *   only the suggested_start, suggested_end, response_note and line_status columns — plus inserts a
 *   daily_brief_items attention row (source 'trade', same enum value
 *   the r15 proposed_change/insurance candidates already use) so staff
 *   see it without the board silently re-dating itself.
 *
 * After EITHER action, if every non-deleted line on this request now
 * has line_status != 'proposed' (lib/trade-booking.ts's
 * allLinesResolved — the trade has given SOME answer, accept or
 * suggest, to every line), the request itself moves to status
 * 'responded' with responded_at=now() (only if not already responded/
 * closed, so this is itself idempotent across repeated calls).
 *
 * Response: { line, request_status } or { error }.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;

  const headerList = await headers();
  const forwardedFor = headerList.get("x-forwarded-for");
  const clientIp = forwardedFor?.split(",")[0]?.trim() || "unknown";
  const limit = rateLimit(`trade-request-respond:${token}:${clientIp}`, 10, 60_000);
  if (!limit.ok) {
    return NextResponse.json({ error: "Too many requests, please try again shortly." }, { status: 429 });
  }

  const supabase = createServiceRoleClient();

  const { data: bookingRequest } = await supabase
    .from("trade_booking_requests")
    .select("*")
    .eq("token", token)
    .maybeSingle();
  if (!bookingRequest) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { data: lineRows } = await supabase
    .from("trade_visits")
    .select("*")
    .eq("booking_request_id", bookingRequest.id)
    .is("deleted_at", null);
  const lines = lineRows ?? [];

  if (isRequestFullyExpired(lines)) {
    return NextResponse.json({ error: "This link has expired." }, { status: 410 });
  }

  let body: TradeRequestRespondInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const line = lines.find((l) => l.id === body.line_id);
  if (!line) {
    return NextResponse.json({ error: "Line not found on this request." }, { status: 404 });
  }

  if (body.action === "accept") {
    if (line.line_status === "accepted") {
      return NextResponse.json({ line, request_status: bookingRequest.status });
    }

    const { data: updated, error } = await supabase
      .from("trade_visits")
      .update({
        line_status: "accepted",
        status: "confirmed",
        confirmed_at: new Date().toISOString(),
        confirmed_by: "trade",
        suggested_start: null,
        suggested_end: null,
      })
      .eq("id", line.id)
      .select()
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Health + web push round (r26), BUILD-SPEC.md item 3(a): "trade
    // accepts/suggests dates (r20 respond route)." Insert + push ONLY —
    // everything above this line is byte-identical to before this
    // round. Best-effort (never fails the response): a notification
    // failing to send must not turn an already-recorded acceptance into
    // an error for the trade contact on the other end of this POST.
    try {
      const { data: acceptTask } = await supabase
        .from("board_tasks")
        .select("title")
        .eq("visit_id", line.id)
        .is("deleted_at", null)
        .maybeSingle();
      const { data: acceptContact } = bookingRequest.contact_id
        ? await supabase.from("contacts").select("company").eq("id", bookingRequest.contact_id).maybeSingle()
        : { data: null };
      const acceptTitle = `Trade confirmed dates — ${acceptContact?.company ?? "Trade"}, ${acceptTask?.title ?? "a task"}`;
      const acceptLinkHref = `/trade-requests/${bookingRequest.id}?focus=line-${line.id}`;
      await supabase.from("notifications").insert({
        user_id: null,
        kind: "trade_confirmed",
        title: acceptTitle,
        body: null,
        link_href: acceptLinkHref,
      });
      await sendPushToAdmins("trade_confirmed", acceptTitle, "", acceptLinkHref);
    } catch {
      // Best-effort — see comment above.
    }

    const requestStatus = await maybeMarkResponded(supabase, bookingRequest, lines, line.id, "accepted");
    return NextResponse.json({ line: updated, request_status: requestStatus });
  }

  if (body.action === "suggest") {
    if (line.line_status === "accepted") {
      return NextResponse.json({ error: "This date is already accepted and locked." }, { status: 400 });
    }
    if (!body.suggested_start || !body.suggested_end) {
      return NextResponse.json({ error: "suggested_start and suggested_end are required." }, { status: 400 });
    }
    if (body.suggested_end < body.suggested_start) {
      return NextResponse.json({ error: "suggested_end must be on or after suggested_start." }, { status: 400 });
    }

    const { data: updated, error } = await supabase
      .from("trade_visits")
      .update({
        suggested_start: body.suggested_start,
        suggested_end: body.suggested_end,
        response_note: body.response_note?.trim() || null,
        line_status: "date_suggested",
      })
      .eq("id", line.id)
      .select()
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // BUILD-SPEC.md item 5 — "Suggestions never move the board":
    // attention item only, board/task dates are untouched by this
    // action entirely.
    const { data: task } = await supabase
      .from("board_tasks")
      .select("id,title")
      .eq("visit_id", line.id)
      .is("deleted_at", null)
      .maybeSingle();
    const { data: contact } = bookingRequest.contact_id
      ? await supabase.from("contacts").select("company").eq("id", bookingRequest.contact_id).maybeSingle()
      : { data: null };
    const company = contact?.company ?? "Trade";
    const taskTitle = task?.title ?? "a task";
    const attentionTitle = `${company} suggested new dates — ${taskTitle}`;
    const attentionLinkHref = `/trade-requests/${bookingRequest.id}?focus=line-${line.id}`;
    // Dedupe guard, same pattern POST /api/brief-submit/[token] already
    // established for its own direct daily_brief_items insert: a trade
    // changing its suggestion more than once before staff resolves the
    // first one (allowed — see TradeRequestLines.tsx's "Change
    // suggestion" affordance) should not pile up multiple open
    // attention rows for the same line.
    const { data: existingOpenAttention } = await supabase
      .from("daily_brief_items")
      .select("id")
      .eq("source", "trade")
      .eq("link_href", attentionLinkHref)
      .eq("status", "open")
      .maybeSingle();
    if (!existingOpenAttention) {
      await supabase.from("daily_brief_items").insert({
        title: attentionTitle,
        source: "trade",
        link_href: attentionLinkHref,
        status: "open",
        created_by_kind: "system",
        project_id: bookingRequest.project_id,
      });
    }

    // Health + web push round (r26), BUILD-SPEC.md item 3(a) — insert +
    // push ONLY, see the 'accept' branch's own identical comment above
    // for why this is best-effort/never-throws. Title per item 3's own
    // exact wording ("suggest -> 'Trade suggested new dates'"); the
    // company/task detail already computed above for the daily-brief
    // item goes in `body` instead, so the push/notification still
    // carries the useful detail without diverging from the spec's
    // literal title text.
    try {
      await supabase.from("notifications").insert({
        user_id: null,
        kind: "trade_suggested",
        title: "Trade suggested new dates",
        body: attentionTitle,
        link_href: attentionLinkHref,
      });
      await sendPushToAdmins("trade_suggested", "Trade suggested new dates", attentionTitle, attentionLinkHref);
    } catch {
      // Best-effort — see comment above.
    }

    const requestStatus = await maybeMarkResponded(supabase, bookingRequest, lines, line.id, "date_suggested");
    return NextResponse.json({ line: updated, request_status: requestStatus });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}

/**
 * Re-checks "every line resolved" using the batch of lines fetched at
 * the top of this request, with the JUST-UPDATED line's new status
 * substituted in (avoiding a second full re-fetch for the common case
 * of a single-line update) — flips the request to 'responded' exactly
 * once (guarded by `bookingRequest.status !== "responded"`, so a
 * second line resolving after the request is already 'responded' never
 * re-writes responded_at).
 */
async function maybeMarkResponded(
  supabase: ReturnType<typeof createServiceRoleClient>,
  bookingRequest: { id: string; status: string },
  lines: { id: string; line_status: string | null; deleted_at?: string | null }[],
  updatedLineId: string,
  updatedLineStatus: string
): Promise<string> {
  if (bookingRequest.status === "responded" || bookingRequest.status === "closed") {
    return bookingRequest.status;
  }
  const projected = lines.map((l) => (l.id === updatedLineId ? { ...l, line_status: updatedLineStatus } : l));
  if (!allLinesResolved(projected)) {
    return bookingRequest.status;
  }
  await supabase
    .from("trade_booking_requests")
    .update({ status: "responded", responded_at: new Date().toISOString() })
    .eq("id", bookingRequest.id);
  return "responded";
}
