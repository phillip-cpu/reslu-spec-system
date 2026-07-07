import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { sendTeamEmail } from "@/lib/gmail/send";
import { formatArrival } from "@/lib/trade-visits";
import { hasAnyDocumentPackChoice, documentPackMentionLine } from "@/lib/trade-doc-pack";
import type { DocumentPackChoices } from "@/types/trade-doc-pack";

/**
 * POST /api/visits/[id]/resend-confirmation
 *
 * BUILD-SPEC.md "Internal timeline — trade visit sub-bars": "if the
 * visit was status 'confirmed', after a successful date change show a
 * non-blocking affordance on the sub-bar 'Dates changed — re-send
 * confirmation?' ... re-confirmation NOT auto-triggered on drag".
 *
 * STATE-MACHINE FINDING (documented here since this route's existence
 * IS that finding): this codebase has NO prior "re-send confirmation"
 * mechanism, and — more surprisingly — no "send initial confirmation
 * request" email either. Tracing every trade_visits email send site
 * (grep for sendTeamEmail across app/api and lib):
 *   - POST /api/projects/[id]/visits (create) sends NOTHING — a new
 *     visit is simply inserted with status='unconfirmed' and the trade
 *     hears nothing until either (a) the day-before cron
 *     (GET /api/trade-reminders) fires 1-2 days out, or (b) staff
 *     manually tell the trade out-of-band and later hit "Confirm on
 *     behalf of trade" (POST /api/visits/[id]/confirm — also sends no
 *     email, it's a staff-side record-keeping action).
 *   - POST /api/visits/[id]/resolve-proposal is the ONLY route that
 *     emails a trade about a specific date, and only ever in response
 *     to THEIR OWN proposed_change counter-proposal (accept/counter) —
 *     it has no path for "here are your unchanged-by-the-trade,
 *     staff-moved dates."
 *   - GET /api/trade-reminders is the only other sender, gated by
 *     status IN ('unconfirmed','tentative') AND reminder_sent_at IS
 *     NULL — i.e. it fires at most ONCE per visit, ever, and never for
 *     an already-'confirmed' visit.
 * So "wire the same send used at creation" (this task's brief) has no
 * literal target — creation has no send. The nearest existing content/
 * tone to reuse is trade-reminders' own email template (contact-facing,
 * plain, includes the confirm-token link), which this route copies for
 * a SINGLE visit, sent immediately, unconditionally (no reminder_sent_at
 * gate — an explicit staff button-press, not a scheduled nudge).
 *
 * WHAT THIS ROUTE DOES (the "reset status appropriately" the brief
 * asks for, in the absence of a pre-existing convention to mirror):
 * only callable when the visit's CURRENT status is 'confirmed' (400
 * otherwise — there's nothing to "re"-confirm for a visit that was
 * never confirmed; the ordinary unconfirmed/tentative path is already
 * covered by the cron + the trade's own /trade/[token] link). On
 * success: status -> 'unconfirmed' (the visit is, factually, no longer
 * confirmed for its NEW dates — 'tentative' was considered but rejected
 * since tentative implies a soft staff-side hold, not "we're waiting to
 * hear back from the trade again," which is exactly unconfirmed's
 * existing meaning), confirmed_at/confirmed_by cleared (they described
 * the OLD, now-superseded confirmation), reminder_sent_at cleared too
 * (so the visit becomes eligible again for the day-before cron nudge if
 * the trade doesn't respond to this immediate resend, same as any other
 * freshly-unconfirmed visit — see that route's is("reminder_sent_at",
 * null) filter). Email failures are fire-and-forget (logged, not
 * thrown) — mirrors resolve-proposal's and trade-reminders' identical
 * "the DB write is the source of truth, notification is best-effort"
 * choice; the status reset above still commits even if Gmail is down or
 * unconfigured. Response: { visit }.
 *
 * "Trade booking document pack" round: when the visit's own
 * document_pack has anything ticked (lib/trade-doc-pack.ts's
 * hasAnyDocumentPackChoice()), the resend body gets the same warm,
 * brief mention line the booking-confirmation and day-before-reminder
 * emails use (documentPackMentionLine()) — kept in one shared helper so
 * all three templates never drift on wording.
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
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .single();
  if (!existing) {
    return NextResponse.json({ error: "Visit not found" }, { status: 404 });
  }
  if (existing.status !== "confirmed") {
    return NextResponse.json(
      { error: "Only a previously confirmed visit can be re-sent for confirmation" },
      { status: 400 }
    );
  }

  const [{ data: phase }, { data: project }, { data: contact }] = await Promise.all([
    supabase.from("schedule_phases").select("name").eq("id", existing.phase_id).maybeSingle(),
    supabase.from("projects").select("name").eq("id", existing.project_id).maybeSingle(),
    existing.contact_id
      ? supabase.from("contacts").select("email,company").eq("id", existing.contact_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const { data: visit, error } = await supabase
    .from("trade_visits")
    .update({
      status: "unconfirmed",
      confirmed_at: null,
      confirmed_by: null,
      reminder_sent_at: null,
    })
    .eq("id", id)
    .is("deleted_at", null)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (contact?.email) {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://spec.reslu.com.au";
    const tradeLink = `${appUrl}/trade/${existing.confirm_token}`;
    const projectName = project?.name ?? "Project";
    const phaseName = phase?.name ?? "Visit";
    const subject = `RESLU — ${projectName}: ${phaseName} — dates changed, please reconfirm`;
    const hasPack = hasAnyDocumentPackChoice(existing.document_pack as DocumentPackChoices | null);
    const body = [
      `Hi ${contact.company},`,
      "",
      `The dates for your visit have changed:`,
      `${visit.start_date}${visit.end_date !== visit.start_date ? ` → ${visit.end_date}` : ""} — ${formatArrival(visit.arrival_slot, visit.arrival_time)}`,
      "",
      `Please confirm this new date, or let us know if it doesn't work: ${tradeLink}`,
      ...(hasPack ? ["", documentPackMentionLine()] : []),
    ].join("\n");
    try {
      await sendTeamEmail({ to: [contact.email], subject, body });
    } catch (err) {
      console.error("resend-confirmation: email send failed", err);
      // Fire-and-forget — the status reset above has already committed.
    }
  }

  return NextResponse.json({ visit });
}
