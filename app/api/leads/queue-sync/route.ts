import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { isFollowUpDue, daysSince } from "@/lib/leads";
import type { Lead } from "@/types";

export const runtime = "nodejs";

/**
 * GET /api/leads/queue-sync — Vercel Cron entry point.
 *
 * RESLU Second Brain, Step 3 (docs/RESLU-second-brain-build-brief.md)
 * — "lead overdue" event site. UNLIKE the other two Step 3 events
 * (materials price-request, trade-reminder), "a lead is overdue" has
 * no natural imperative write site anywhere in this codebase —
 * GET /api/leads/attention's computeAttentionGroups() (lib/leads.ts)
 * is a pure, read-only derivation recomputed fresh on every call, not
 * a state transition that gets "raised" once. This route is new: a
 * daily cron that evaluates the exact same follow-up-due condition
 * that panel already uses (isFollowUpDue(), lib/leads.ts — no
 * duplicated logic) and raises an aria_queue row for each lead that
 * qualifies, with the brief's own weekly dedupe so a lead sitting
 * overdue for a month raises exactly one queue row per week, not one
 * per day.
 *
 * Scoped specifically to the `follow_ups_due` group (not `nurture` /
 * `stale_proposals` / `site_visits_upcoming`) — it's the one group
 * with an unambiguous "days_overdue" figure (today minus a specific
 * due date), matching the brief's literal payload shape
 * `{lead_id, days_overdue}`; the other groups measure "days in a
 * stage" or "days until an upcoming date", which don't fit that same
 * shape. No stage filter beyond what computeAttentionGroups() itself
 * already applies (none, for this group) — mirrors GET
 * /api/leads/attention's existing behaviour exactly rather than
 * inventing a stricter rule this round.
 *
 * Auth: mirrors app/api/trade-reminders/route.ts's exact pattern —
 * accepts either `Authorization: Bearer ${CRON_SECRET}` (Vercel
 * Cron's real entry point) or an authenticated team session (manual
 * "run now" trigger).
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
  const now = new Date();

  const { data: leads, error } = await supabase
    .from("leads")
    .select("id,follow_up_date")
    .is("deleted_at", null);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const overdue = (leads ?? []).filter((l): l is Pick<Lead, "id" | "follow_up_date"> & { follow_up_date: string } =>
    isFollowUpDue(l.follow_up_date, now)
  );

  if (overdue.length === 0) {
    return NextResponse.json({ raised: 0, skipped: 0 });
  }

  // ISO week (Monday-based, per the ISO 8601 definition every other
  // "weekly" cadence in this codebase already assumes — e.g.
  // lib/gantt.ts's startOfWeek) — the brief's own dedupe granularity
  // for this event.
  const isoWeek = (() => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
  })();

  let raised = 0;
  let skipped = 0;

  for (const lead of overdue) {
    const days_overdue = daysSince(lead.follow_up_date, now);
    const { error: insertError } = await supabase.from("aria_queue").insert({
      kind: "lead_flag",
      payload: { lead_id: lead.id, days_overdue },
      dedupe_key: `lead_flag:${lead.id}:${isoWeek}`,
      source: "leads-queue-sync-cron",
    });
    if (insertError) {
      if (insertError.code === "23505") {
        skipped++; // Already raised this lead this week — expected, silent no-op.
      } else {
        console.error("leads-queue-sync: aria_queue insert failed for lead", lead.id, insertError.message);
      }
      continue;
    }
    raised++;
  }

  return NextResponse.json({ raised, skipped });
}
