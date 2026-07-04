import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import type { LeadStageEvent } from "@/types";

export const runtime = "nodejs";

/**
 * GET /api/leads/[id]/history
 * Admin-only. Returns the full lead_stage_events timeline for a lead,
 * newest first — BUILD-SPEC.md "Detail panel: ... stage history
 * timeline from lead_stage_events". A dedicated route (rather than
 * requiring the client to have just called the stage-move POST, which
 * also returns `events`) so the detail panel can load history
 * independently on open/refresh.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();

  const info = await getUserRole(supabase);
  if (!info) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (info.role !== "admin") {
    return NextResponse.json({ error: "Only admins can access leads" }, { status: 403 });
  }

  const { data: lead, error: leadError } = await supabase
    .from("leads")
    .select("id")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (leadError) {
    return NextResponse.json({ error: leadError.message }, { status: 500 });
  }
  if (!lead) {
    return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  }

  const { data: events, error } = await supabase
    .from("lead_stage_events")
    .select("*")
    .eq("lead_id", id)
    .order("at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ events: (events ?? []) as LeadStageEvent[] });
}
