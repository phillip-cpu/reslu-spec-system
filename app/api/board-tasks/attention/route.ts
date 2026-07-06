import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { computeBookingsOverdue, type BookingsOverdueSourceTask } from "@/lib/board-cockpit";
import type { BookingsOverdueResponse } from "@/types/board-cockpit";

export const runtime = "nodejs";

/**
 * GET /api/board-tasks/attention
 * Board cockpit round (7 July 2026) — Aria booking-chase attention
 * feed 'bookings_overdue'. Team session, NO admin gate — mirrors
 * GET /api/visits/attention's exact reasoning (scheduling data, not
 * financial). Same thin-route + lib/*.ts pure-compute-function shape
 * as every other attention endpoint in this codebase (GET
 * /api/visits/attention -> lib/trade-visits.ts computeVisitAttention;
 * GET /api/contacts/attention -> lib/insurance.ts
 * computeInsuranceAttention; GET /api/leads/attention -> lib/leads.ts
 * computeAttentionGroups) — no SQL view, matching that established
 * convention rather than introducing the first one of its kind.
 *
 * Returns board_tasks rows either (a) booked (booking_date in the
 * past) with the linked trade_visits row still unconfirmed/tentative/
 * proposed_change, or (b) a milestone-kind card with an overdue
 * due_date — see lib/board-cockpit.ts's computeBookingsOverdue() doc
 * comment for the exact two-reason rule. This is the feed the MCP tool
 * `book_trade_visit`'s sibling read tool (get_bookings_overdue, this
 * round's mcp/src/index.mjs addition) surfaces to Aria.
 */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Only rows that could possibly qualify: either a booking_date is
  // set, or the card is a milestone with a due_date — narrows the scan
  // before the pure compute function does its date-comparison work.
  const { data: candidates, error } = await supabase
    .from("board_tasks")
    .select("id,title,project_id,kind,due_date,booking_date,visit_id,contact_id")
    .is("deleted_at", null)
    .or("booking_date.not.is.null,and(kind.eq.milestone,due_date.not.is.null)");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = candidates ?? [];
  const visitIds = [...new Set(rows.map((r) => r.visit_id).filter(Boolean))] as string[];

  const { data: visits } = visitIds.length
    ? await supabase.from("trade_visits").select("id,status").in("id", visitIds)
    : { data: [] as { id: string; status: string }[] };
  const visitStatusById = new Map((visits ?? []).map((v) => [v.id, v.status]));

  const sourceTasks: BookingsOverdueSourceTask[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    project_id: r.project_id,
    kind: r.kind,
    due_date: r.due_date,
    booking_date: r.booking_date,
    visit_status: (r.visit_id ? (visitStatusById.get(r.visit_id) as BookingsOverdueSourceTask["visit_status"]) : null) ?? null,
    contact_id: r.contact_id,
  }));

  const overdue = computeBookingsOverdue(sourceTasks);
  if (overdue.length === 0) {
    return NextResponse.json({ bookings_overdue: [] } satisfies BookingsOverdueResponse);
  }

  const taskById = new Map(rows.map((r) => [r.id, r]));
  const projectIds = [...new Set(overdue.map((o) => taskById.get(o.task_id)?.project_id).filter(Boolean))] as string[];
  const contactIds = [
    ...new Set(overdue.map((o) => taskById.get(o.task_id)?.contact_id).filter(Boolean)),
  ] as string[];

  const [{ data: projects }, { data: contacts }] = await Promise.all([
    projectIds.length
      ? supabase.from("projects").select("id,name").in("id", projectIds)
      : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    contactIds.length
      ? supabase.from("contacts").select("id,company,contact_name").in("id", contactIds)
      : Promise.resolve({ data: [] as { id: string; company: string; contact_name: string | null }[] }),
  ]);
  const projectById = new Map((projects ?? []).map((p) => [p.id, p.name]));
  const contactById = new Map((contacts ?? []).map((c) => [c.id, c]));

  const body: BookingsOverdueResponse = {
    bookings_overdue: overdue.map((o) => {
      const task = taskById.get(o.task_id)!;
      return {
        task_id: o.task_id,
        title: task.title,
        project_id: task.project_id,
        project_name: projectById.get(task.project_id) ?? "—",
        reason: o.reason,
        date: o.date,
        visit_status: (task.visit_id ? (visitStatusById.get(task.visit_id) as BookingsOverdueSourceTask["visit_status"]) : null) ?? null,
        contact: task.contact_id ? contactById.get(task.contact_id) ?? null : null,
      };
    }),
  };

  return NextResponse.json(body);
}
