import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { computeAttentionGroups } from "@/lib/leads";
import type { Lead, LeadStageEvent } from "@/types";

export const runtime = "nodejs";

/**
 * GET /api/leads/attention
 * Admin-only. Returns the four needs-attention groups — BUILD-SPEC.md
 * "Needs-attention panel": "Proposal Sent >=4 days (nurture
 * candidates) + Awaiting to Send Proposal >=7 days (stale proposals) +
 * follow_up_date due/past" + "site_visits_upcoming: next 7 days". This
 * is the exact route BUILD-SPEC's "Aria API layer" names for her
 * nurturer/monitor automations to poll.
 *
 * Only fetches lead_stage_events for leads currently in 'Proposal
 * Sent' or 'Awaiting to Send Proposal' (the two stages whose
 * thresholds need a "time since entering this stage" lookup) — every
 * other lead's due-ness (follow_up_date, site_visit_date) is a plain
 * column comparison needing no event history at all.
 */
export async function GET() {
  const supabase = await createClient();

  const info = await getUserRole(supabase);
  if (!info) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (info.role !== "admin") {
    return NextResponse.json({ error: "Only admins can access leads" }, { status: 403 });
  }

  const { data: leads, error } = await supabase
    .from("leads")
    .select("*")
    .is("deleted_at", null);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const typedLeads = (leads ?? []) as Lead[];

  const stageTrackedIds = typedLeads
    .filter((l) => l.stage === "Proposal Sent" || l.stage === "Awaiting to Send Proposal")
    .map((l) => l.id);

  const eventsByLead = new Map<string, LeadStageEvent[]>();
  if (stageTrackedIds.length > 0) {
    const { data: events, error: eventsError } = await supabase
      .from("lead_stage_events")
      .select("*")
      .in("lead_id", stageTrackedIds);
    if (eventsError) {
      return NextResponse.json({ error: eventsError.message }, { status: 500 });
    }
    for (const e of (events ?? []) as LeadStageEvent[]) {
      const arr = eventsByLead.get(e.lead_id) ?? [];
      arr.push(e);
      eventsByLead.set(e.lead_id, arr);
    }
  }

  const groups = computeAttentionGroups(typedLeads, eventsByLead);

  return NextResponse.json(groups);
}
