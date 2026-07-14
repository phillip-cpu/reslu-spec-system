import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { TradeBookingRequestDetail, TradeBookingRequestLine } from "@/types/round-grouped-trade-booking";
import {
  countTradeBookingLines,
  deriveTradeBookingProgress,
  tradeBookingEmailEvidenceFromRow,
} from "@/lib/trade-booking-progress";

export const runtime = "nodejs";

/**
 * GET /api/trade-requests/[id]
 *
 * Grouped trade booking round (r20) — admin detail view for one
 * trade_booking_requests row: the request envelope plus every line
 * (trade_visits row with booking_request_id = this id), each annotated
 * with its task title + phase name for display. Authenticated team
 * session only (unlike the public /trade-request/[token] page/respond
 * route, which is service-role + token-gated).
 */
export async function GET(
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

  const [{ data: project }, { data: contact }, { data: visits }, { data: latestEmail }] = await Promise.all([
    supabase.from("projects").select("id,name").eq("id", bookingRequest.project_id).maybeSingle(),
    bookingRequest.contact_id
      ? supabase.from("contacts").select("id,company,contact_name,email").eq("id", bookingRequest.contact_id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from("trade_visits")
      .select("id,phase_id,start_date,end_date,status,line_status,suggested_start,suggested_end,response_note,deleted_at")
      .eq("booking_request_id", id)
      .is("deleted_at", null),
    supabase
      .from("email_sends")
      .select("*")
      .eq("record_type", "trade_booking_request")
      .eq("record_id", id)
      .eq("template", "trade-booking-request")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const visitRows = visits ?? [];
  const phaseIds = [...new Set(visitRows.map((v) => v.phase_id))];
  const visitIds = visitRows.map((v) => v.id);

  const [{ data: phases }, { data: linkedTasks }] = await Promise.all([
    phaseIds.length
      ? supabase.from("schedule_phases").select("id,name").in("id", phaseIds)
      : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    visitIds.length
      ? supabase.from("board_tasks").select("id,title,visit_id").in("visit_id", visitIds).is("deleted_at", null)
      : Promise.resolve({ data: [] as { id: string; title: string; visit_id: string | null }[] }),
  ]);

  const phaseNameById = new Map((phases ?? []).map((p) => [p.id, p.name]));
  const taskByVisitId = new Map((linkedTasks ?? []).map((t) => [t.visit_id, t]));

  const lines: TradeBookingRequestLine[] = visitRows.map((v) => {
    const task = taskByVisitId.get(v.id);
    return {
      id: v.id,
      task_id: task?.id ?? null,
      task_title: task?.title ?? "(unlinked task)",
      phase_id: v.phase_id,
      phase_name: phaseNameById.get(v.phase_id) ?? "Phase",
      start_date: v.start_date,
      end_date: v.end_date,
      status: v.status,
      // Every trade_visits row this query returns has booking_request_id
      // = this request's id, so line_status is always non-null in
      // practice (set by POST /api/projects/[id]/trade-requests at
      // creation time) — the `?? "proposed"` fallback only guards a
      // theoretical row written by future code that forgets to set it.
      line_status: (v.line_status as TradeBookingRequestLine["line_status"]) ?? "proposed",
      suggested_start: v.suggested_start,
      suggested_end: v.suggested_end,
      response_note: v.response_note,
    };
  });

  const email = tradeBookingEmailEvidenceFromRow(latestEmail as Record<string, unknown> | null);
  const counts = countTradeBookingLines(lines);
  const detail: TradeBookingRequestDetail = {
    request: bookingRequest,
    project: project ? { id: project.id, name: project.name } : null,
    contact: contact
      ? { id: contact.id, company: contact.company, contact_name: contact.contact_name, email: contact.email }
      : null,
    lines,
    email,
    counts,
    progress: deriveTradeBookingProgress({
      request: bookingRequest,
      email,
      counts,
    }),
  };

  return NextResponse.json(detail);
}
