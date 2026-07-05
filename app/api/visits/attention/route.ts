import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { computeVisitAttention } from "@/lib/trade-visits";
import type { TradeVisit, VisitContactSummary } from "@/lib/trade-visits";

export const runtime = "nodejs";

/**
 * GET /api/visits/attention
 * Team session, NO admin gate. Trade visits/timeline scheduling data
 * is not financial (unlike leads' pipeline values, which IS why
 * GET /api/leads/attention is admin-only) — this is a deliberate
 * deviation from that route's admin gate, consistent with the rest of
 * this Phase's routes (phases/visits routes are all team-visible, no
 * admin check, same reasoning as migration 013/015's RLS comments).
 *
 * Returns the two needs-attention groups from
 * lib/trade-visits.ts's computeVisitAttention: `proposed_pending`
 * (status === 'proposed_change') and `starting_soon` (unconfirmed/
 * tentative visits starting within the next 3 days). Each visit is
 * annotated with a lightweight phase name + project name + contact
 * summary (batched, not N+1) so the panel can render without extra
 * round-trips.
 */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: visits, error } = await supabase
    .from("trade_visits")
    .select("*")
    .is("deleted_at", null)
    .in("status", ["proposed_change", "unconfirmed", "tentative"]);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const typedVisits = (visits ?? []) as TradeVisit[];
  const groups = computeVisitAttention(typedVisits);

  const relevant = [...groups.proposed_pending, ...groups.starting_soon];
  const phaseIds = [...new Set(relevant.map((v) => v.phase_id))];
  const projectIds = [...new Set(relevant.map((v) => v.project_id))];
  const contactIds = [...new Set(relevant.map((v) => v.contact_id).filter(Boolean))] as string[];

  const [{ data: phases }, { data: projects }, { data: contacts }] = await Promise.all([
    phaseIds.length
      ? supabase.from("schedule_phases").select("id,name").in("id", phaseIds)
      : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    projectIds.length
      ? supabase.from("projects").select("id,name").in("id", projectIds)
      : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    contactIds.length
      ? supabase.from("contacts").select("id,company,contact_name").in("id", contactIds)
      : Promise.resolve({ data: [] as VisitContactSummary[] }),
  ]);

  const phaseById = new Map((phases ?? []).map((p) => [p.id, p.name]));
  const projectById = new Map((projects ?? []).map((p) => [p.id, p.name]));
  const contactById = new Map((contacts ?? []).map((c) => [c.id, c]));

  function annotate(visit: TradeVisit) {
    return {
      ...visit,
      phase_name: phaseById.get(visit.phase_id) ?? null,
      project_name: projectById.get(visit.project_id) ?? null,
      contact: visit.contact_id ? contactById.get(visit.contact_id) ?? null : null,
    };
  }

  return NextResponse.json({
    proposed_pending: groups.proposed_pending.map(annotate),
    starting_soon: groups.starting_soon.map(annotate),
  });
}
