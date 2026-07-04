import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { LEAD_STAGES, type Lead, type MoveLeadStageInput } from "@/types";

export const runtime = "nodejs";

/**
 * POST /api/leads/[id]/stage
 * Admin-only. body: { stage }. The single documented path for a stage
 * change — used by the kanban board's drag-drop (components/leads/
 * LeadsBoard.tsx) and by Aria (BUILD-SPEC.md "Aria API layer": leads
 * CRUD + stage move"). The actual write is a plain
 * `update({ stage })`; the lead_stage_events row is written by the
 * trg_leads_stage_change DB trigger (supabase/migrations/014_leads.sql)
 * — this route does not insert into lead_stage_events itself, so there
 * is exactly one writer of that table and no risk of a double-write.
 * Returns the updated lead AND its full stage-change history inline
 * (`events`) — the client needs the refreshed timeline immediately
 * after a move, so this avoids a second round trip. The same history
 * is also independently fetchable via GET /api/leads/[id]/history
 * (used by the detail panel on open/refresh, when a fresh stage move
 * hasn't just happened).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();

  const info = await getUserRole(supabase);
  if (!info) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (info.role !== "admin") {
    return NextResponse.json({ error: "Only admins can move leads" }, { status: 403 });
  }

  let body: MoveLeadStageInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.stage || !LEAD_STAGES.includes(body.stage)) {
    return NextResponse.json({ error: `Invalid or missing stage` }, { status: 400 });
  }

  const { data: existing, error: fetchError } = await supabase
    .from("leads")
    .select("id")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (fetchError) {
    return NextResponse.json({ error: fetchError.message }, { status: 500 });
  }
  if (!existing) {
    return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  }

  const { data: lead, error } = await supabase
    .from("leads")
    .update({ stage: body.stage })
    .eq("id", id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const { data: events } = await supabase
    .from("lead_stage_events")
    .select("*")
    .eq("lead_id", id)
    .order("at", { ascending: false });

  return NextResponse.json({ lead: lead as Lead, events: events ?? [] });
}
