import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { sendTeamEmail } from "@/lib/gmail/send";
import { formatArrival, findOverlappingVisits } from "@/lib/trade-visits";
import type { TradeVisit } from "@/lib/trade-visits";
import { hasAnyDocumentPackChoice, documentPackMentionLine } from "@/lib/trade-doc-pack";
import type { DocumentPackChoices } from "@/types/trade-doc-pack";

export const runtime = "nodejs";

/**
 * GET /api/trade-reminders — Vercel Cron entry point ("day before"
 * trade-visit reminder emails).
 *
 * Timezone reasoning (contrast with app/api/digest/flush/route.ts's
 * exact-hour Adelaide check): the digest cron must land on precise
 * 9am/12pm/4pm SLOTS, so it re-derives the current Adelaide hour from
 * UTC on every invocation and only actually flushes on a matching
 * slot. This reminder is a much coarser "day before" nudge — it fires
 * ONCE per day at a fixed UTC time (21:00 UTC = 07:30 ACST, Adelaide
 * standard time, UTC+9:30) and looks for visits starting 1 OR 2 days
 * from the server's UTC "today" (a deliberate ±1-day fuzz — see the
 * query below). Because `reminder_sent_at` gates every send (a visit
 * is only ever reminded once, see the query filter), firing at a fixed
 * UTC time that drifts by up to an hour across Adelaide's daylight-
 * saving transitions is harmless: the visit still gets exactly one
 * reminder, 1-2 calendar days out, regardless of whether "21:00 UTC"
 * happens to be 6:30am or 7:30am locally that week. This is
 * deliberately NOT DST-corrected like the digest cron is — the digest
 * has a real user-facing promise ("digest lands at 9am"), whereas this
 * reminder's promise is only "you'll hear from us a day or two before
 * your visit", which a half-hour drift never violates.
 *
 * Auth: accepts EITHER `authorization: Bearer ${CRON_SECRET}` (Vercel
 * Cron's actual entry point, cookieless) OR an authenticated team
 * session (manual "run reminders now" trigger) — mirrors
 * app/api/digest/flush/route.ts's POST handler's isCronCall fallback
 * pattern, adapted onto this route's single GET handler since Vercel
 * Cron only issues GET.
 */
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");
  const isCronCall = !!cronSecret && authHeader === `Bearer ${cronSecret}`;

  if (!isCronCall) {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const supabase = createServiceRoleClient();
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://spec.reslu.com.au";

  const today = new Date();
  const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const oneDayOut = new Date(todayUtc.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const twoDaysOut = new Date(todayUtc.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // Invariant (defensive comment, per verification checklist): an
  // umbrella-kind phase can never have trade_visits rows against it —
  // POST /api/projects/[id]/visits rejects visit creation for
  // phase.kind === 'umbrella' at the source — so this query never
  // needs to (and does not) filter by phase kind; every row it reads
  // is structurally guaranteed to be a real, phase-owned visit.
  // BUILD-SPEC.md r27 item 4 — a CONFIRMED visit still needs its
  // day-before nudge; the original filter only covered 'unconfirmed'/
  // 'tentative', so a trade who'd already confirmed silently got no
  // reminder at all. `reminder_sent_at is null` below is still the one
  // dedupe guard (unchanged) — each visit is reminded exactly once
  // regardless of which of these three statuses it's in when the cron
  // runs.
  const { data: visits, error } = await supabase
    .from("trade_visits")
    .select("*")
    .is("deleted_at", null)
    .in("status", ["unconfirmed", "tentative", "confirmed"])
    .is("reminder_sent_at", null)
    .in("start_date", [oneDayOut, twoDaysOut]);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const typedVisits = (visits ?? []) as TradeVisit[];

  if (typedVisits.length === 0) {
    return NextResponse.json({ sent: 0, skipped: 0, failed: 0 });
  }

  // ---- Batch-fetch everything needed to render the emails (avoid N+1) ----
  const phaseIds = [...new Set(typedVisits.map((v) => v.phase_id))];
  const projectIds = [...new Set(typedVisits.map((v) => v.project_id))];
  const contactIds = [...new Set(typedVisits.map((v) => v.contact_id).filter(Boolean))] as string[];

  const [{ data: phases }, { data: projects }, { data: contacts }, { data: allProjectVisits }] = await Promise.all([
    phaseIds.length
      ? supabase.from("schedule_phases").select("id,name").in("id", phaseIds)
      : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    projectIds.length
      ? supabase.from("projects").select("id,name").in("id", projectIds)
      : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    contactIds.length
      ? supabase.from("contacts").select("id,email,company,category").in("id", contactIds)
      : Promise.resolve({ data: [] as { id: string; email: string | null; company: string; category: string | null }[] }),
    // Every visit in the affected projects, for the overlap ("who else
    // is on site") computation — fetched once per batch, not per visit.
    projectIds.length
      ? supabase
          .from("trade_visits")
          .select("id,project_id,start_date,end_date,status,deleted_at,contact_id")
          .in("project_id", projectIds)
      : Promise.resolve({ data: [] as (TradeVisit & { contact_id: string | null })[] }),
  ]);

  const phaseById = new Map((phases ?? []).map((p) => [p.id, p.name]));
  const projectById = new Map((projects ?? []).map((p) => [p.id, p.name]));
  const contactById = new Map((contacts ?? []).map((c) => [c.id, c]));
  const visitsByProject = new Map<string, (TradeVisit & { contact_id: string | null })[]>();
  for (const v of allProjectVisits ?? []) {
    const list = visitsByProject.get(v.project_id) ?? [];
    list.push(v as TradeVisit & { contact_id: string | null });
    visitsByProject.set(v.project_id, list);
  }

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const visit of typedVisits) {
    const contact = visit.contact_id ? contactById.get(visit.contact_id) : null;
    if (!contact?.email) {
      // No contact or no email on file — nothing to send to; not an
      // error, just nothing to do for this visit.
      continue;
    }

    const phaseName = phaseById.get(visit.phase_id) ?? "Visit";
    const projectName = projectById.get(visit.project_id) ?? "Project";
    const projectVisits = visitsByProject.get(visit.project_id) ?? [];

    const overlapping = findOverlappingVisits(visit, projectVisits).filter(
      (v) => v.status === "confirmed" || v.status === "tentative"
    );

    const whoElseLines = overlapping
      .map((v) => {
        const otherContact = v.contact_id ? contactById.get(v.contact_id) : null;
        const label = otherContact?.company ?? "Trade";
        return `  - ${label} (${v.status === "confirmed" ? "Confirmed" : "Tentative"})`;
      })
      .filter(Boolean);

    const link = `${appUrl}/trade/${visit.confirm_token}`;
    const subject = `RESLU — ${projectName}: ${phaseName} ${visit.start_date}`;
    // "Trade booking document pack" round — `visit` came off this
    // route's own `select("*")` above, so `document_pack` is present
    // on the raw row even though lib/trade-visits.ts's TradeVisit type
    // (this round did not touch that file) doesn't declare it; cast
    // narrowly, same "read-only reuse via a cast" pattern the other two
    // email send sites use.
    const hasPack = hasAnyDocumentPackChoice(
      (visit as unknown as { document_pack: DocumentPackChoices | null }).document_pack
    );
    const body = [
      `Hi ${contact.company},`,
      "",
      `Reminder — you're nominated for a site visit:`,
      `${visit.start_date}${visit.end_date !== visit.start_date ? ` → ${visit.end_date}` : ""} — ${formatArrival(visit.arrival_slot, visit.arrival_time)}`,
      "",
      ...(whoElseLines.length ? ["Who else is on site this week:", ...whoElseLines, ""] : []),
      `Please confirm or let us know if anything's changed: ${link}`,
      ...(hasPack ? ["", documentPackMentionLine()] : []),
    ].join("\n");

    try {
      const result = await sendTeamEmail({ to: [contact.email], subject, body });
      if (result.skipped) {
        // Gmail not configured — do NOT stamp reminder_sent_at, so
        // this visit is retried on the next run once Gmail is wired
        // up (a config-skip is not the same as "already reminded").
        skipped++;
        continue;
      }
      await supabase
        .from("trade_visits")
        .update({ reminder_sent_at: new Date().toISOString() })
        .eq("id", visit.id);
      sent++;

      // RESLU Second Brain, Step 3 (docs/RESLU-second-brain-build-brief.md)
      // — "trade reminder due" event site. Raised at the same point the
      // reminder EMAIL actually sends (not earlier — a Gmail-config skip
      // above `continue`s before reaching here, so this never fires for
      // a reminder that didn't really go out), alongside that email, not
      // instead of it. `trade` is the contact's category (e.g.
      // "Plumber") — falls back to company name when no category is set
      // — since deduping by trade TYPE within a project/date makes more
      // sense than deduping by one specific company. Dedupe key already
      // includes due_date (per the brief's own literal spec), so it's
      // naturally unique per occurrence with no separate week component
      // needed — on conflict do nothing.
      const trade = contact.category ?? contact.company;
      await supabase
        .from("aria_queue")
        .insert({
          kind: "trade_reminder",
          payload: { project_id: visit.project_id, trade, due_date: visit.start_date, visit_id: visit.id },
          dedupe_key: `trade_reminder:${visit.project_id}:${trade}:${visit.start_date}`,
          source: "trade-reminders-cron",
        })
        .then(({ error: queueError }) => {
          if (queueError && queueError.code !== "23505") {
            console.error("trade-reminders: aria_queue insert failed for visit", visit.id, queueError.message);
          }
        });
    } catch (err) {
      console.error("trade-reminders: send failed for visit", visit.id, err);
      failed++;
      // One failure must not abort the whole batch — continue to the
      // next visit.
    }
  }

  return NextResponse.json({ sent, skipped, failed });
}
