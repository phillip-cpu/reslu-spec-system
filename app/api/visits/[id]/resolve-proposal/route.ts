import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { sendTeamEmail } from "@/lib/gmail/send";
import { formatArrival } from "@/lib/trade-visits";
import type { ResolveProposalInput, ArrivalSlot } from "@/lib/trade-visits";

const VALID_SLOTS = new Set<ArrivalSlot>(["first_thing", "midday", "afternoon"]);

/**
 * POST /api/visits/[id]/resolve-proposal
 * Team session, no admin gate. body: ResolveProposalInput —
 * { action: 'accept' } | { action: 'counter', start_date, end_date,
 * arrival_slot?, arrival_time?, note? }. Only valid when
 * visit.status === 'proposed_change' (400 otherwise).
 *
 * accept: copies proposed_start/end/slot/time onto start_date/end_date/
 * arrival_slot/arrival_time, clears the proposed_* fields, sets
 * status='confirmed', confirmed_at=now(), confirmed_by='staff'. If the
 * visit's contact has an email and Gmail is configured, sends a plain
 * confirmation email with a link back to /trade/[confirm_token] and
 * the finalized date/time. The send is wrapped in try/catch — a Gmail
 * failure is logged server-side (console.error) but does NOT fail the
 * request; the visit is still updated and 200 is still returned. This
 * fire-and-forget choice mirrors the codebase's existing "the DB write
 * is the source of truth, notification is best-effort" pattern (e.g.
 * the Monday sync fire-and-forget on item status change) — a trade's
 * confirmed slot must not be lost just because an email bounced.
 *
 * counter: staff proposes ANOTHER set of dates back to the trade —
 * overwrites proposed_start/end/slot/time/note with the staff's
 * counter-proposal. status STAYS 'proposed_change' (not reset to
 * 'unconfirmed' or 'confirmed') so the trade sees the new proposed
 * date next time they open their link, and so this same route/UI
 * continues to treat the visit as "awaiting a decision" — the decision
 * is just now pending on the TRADE's side instead of staff's. Sends a
 * separate counter-offer email, same fail-open behaviour.
 *
 * Response: { visit }.
 */
export async function POST(
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
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .single();
  if (!existing) {
    return NextResponse.json({ error: "Visit not found" }, { status: 404 });
  }
  if (existing.status !== "proposed_change") {
    return NextResponse.json(
      { error: "This visit has no pending proposal to resolve" },
      { status: 400 }
    );
  }

  let body: ResolveProposalInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (body.action !== "accept" && body.action !== "counter") {
    return NextResponse.json({ error: "action must be 'accept' or 'counter'" }, { status: 400 });
  }

  // Fetch project/phase names + contact for email context regardless
  // of action (both accept and counter send an email).
  const [{ data: phase }, { data: project }, { data: contact }] = await Promise.all([
    supabase.from("schedule_phases").select("name").eq("id", existing.phase_id).maybeSingle(),
    supabase.from("projects").select("name").eq("id", existing.project_id).maybeSingle(),
    existing.contact_id
      ? supabase.from("contacts").select("email,company").eq("id", existing.contact_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://spec.reslu.com.au";
  const tradeLink = `${appUrl}/trade/${existing.confirm_token}`;

  let update: Record<string, unknown>;
  let emailSubject: string;
  let emailBody: string;

  if (body.action === "accept") {
    update = {
      start_date: existing.proposed_start,
      end_date: existing.proposed_end,
      arrival_slot: existing.proposed_slot,
      arrival_time: existing.proposed_time,
      proposed_start: null,
      proposed_end: null,
      proposed_slot: null,
      proposed_time: null,
      proposed_note: null,
      status: "confirmed",
      confirmed_at: new Date().toISOString(),
      confirmed_by: "staff",
    };
    emailSubject = `RESLU — ${project?.name ?? "Project"}: ${phase?.name ?? "Visit"} confirmed`;
    emailBody = [
      `Hi${contact?.company ? " " + contact.company : ""},`,
      "",
      `Your proposed date has been accepted and confirmed:`,
      `${existing.proposed_start} — ${formatArrival(existing.proposed_slot, existing.proposed_time)}`,
      "",
      `View or update this visit: ${tradeLink}`,
    ].join("\n");
  } else {
    if (!body.start_date || !body.end_date) {
      return NextResponse.json(
        { error: "start_date and end_date are required for a counter-proposal" },
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
    update = {
      proposed_start: body.start_date,
      proposed_end: body.end_date,
      proposed_slot: body.arrival_slot || null,
      proposed_time: body.arrival_time || null,
      proposed_note: body.note?.trim() || null,
      // status intentionally stays 'proposed_change' — see doc comment.
    };
    emailSubject = `RESLU — ${project?.name ?? "Project"}: ${phase?.name ?? "Visit"} — new date proposed`;
    emailBody = [
      `Hi${contact?.company ? " " + contact.company : ""},`,
      "",
      `We'd like to propose a different date for this visit:`,
      `${body.start_date} — ${formatArrival(body.arrival_slot ?? null, body.arrival_time ?? null)}`,
      body.note ? `Note: ${body.note}` : null,
      "",
      `Please confirm or propose another day: ${tradeLink}`,
    ]
      .filter(Boolean)
      .join("\n");
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

  if (contact?.email) {
    try {
      await sendTeamEmail({ to: [contact.email], subject: emailSubject, body: emailBody });
    } catch (err) {
      console.error("resolve-proposal: email send failed", err);
      // Fire-and-forget — do not fail the request, see doc comment above.
    }
  }

  return NextResponse.json({ visit });
}
