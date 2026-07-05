import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/rate-limit";
import { isVisitExpired } from "@/lib/trade-visits";
import type { TradeRespondInput, ArrivalSlot } from "@/lib/trade-visits";

export const runtime = "nodejs";

const VALID_SLOTS = new Set<ArrivalSlot>(["first_thing", "midday", "afternoon"]);

/**
 * POST /api/trade/[token]/respond
 * Public, unauthenticated — token-gated (confirm_token), like every
 * portal mutation route. Rate-limited tighter than the page GET
 * (10/min) since this is a mutation, not a read.
 *
 * Token expiry (deleted_at set, or today > end_date) is re-checked
 * HERE independently of the page component — a direct POST (e.g. a
 * stale bookmarked page's form submit, or a scripted request) must not
 * be able to confirm/propose against an expired visit even if the
 * caller never loaded the page first.
 *
 * body: TradeRespondInput, dispatched on `action`:
 *
 * - 'confirm': sets status='confirmed', confirmed_at=now(),
 *   confirmed_by='trade'. If the visit has NEITHER arrival_slot NOR
 *   arrival_time already set, an arrival nomination is REQUIRED as
 *   part of this action — the body must supply arrival_slot or
 *   arrival_time, or this 400s with a clear message (the UI is
 *   expected to force the picker to appear in that case, see
 *   components/trade/TradeRespondForm.tsx). If supplied, arrival_slot/
 *   arrival_time are set at confirm time (this does not count as
 *   "confirm different time" — it's the FIRST nomination, not a change).
 *
 * - 'confirm_different_time': auto-accepted immediately, no staff
 *   approval needed (same-day time change) — sets arrival_slot/
 *   arrival_time to the new values, status='confirmed',
 *   confirmed_at=now(), confirmed_by='trade', AND appends an FYI line
 *   to `notes` (rather than adding a new column) so staff have a
 *   visible trail of the change without a schema addition for what is
 *   fundamentally a same-day, low-stakes adjustment.
 *
 * - 'propose': sets proposed_start/end/slot/time/note,
 *   status='proposed_change'. Validates proposed_end >= proposed_start.
 *
 * Response: { visit } or { error }.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;

  const headerList = await headers();
  const forwardedFor = headerList.get("x-forwarded-for");
  const clientIp = forwardedFor?.split(",")[0]?.trim() || "unknown";
  const limit = rateLimit(`trade-respond:${token}:${clientIp}`, 10, 60_000);
  if (!limit.ok) {
    return NextResponse.json({ error: "Too many requests, please try again shortly." }, { status: 429 });
  }

  const supabase = createServiceRoleClient();

  const { data: visit } = await supabase
    .from("trade_visits")
    .select("*")
    .eq("confirm_token", token)
    .maybeSingle();

  if (!visit) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (isVisitExpired(visit)) {
    return NextResponse.json({ error: "This link has expired." }, { status: 410 });
  }

  let body: TradeRespondInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (body.action === "confirm") {
    const hasExisting = visit.arrival_slot || visit.arrival_time;
    const hasSupplied = body.arrival_slot || body.arrival_time;
    if (!hasExisting && !hasSupplied) {
      return NextResponse.json(
        { error: "Please choose an arrival time before confirming." },
        { status: 400 }
      );
    }
    if (body.arrival_slot && !VALID_SLOTS.has(body.arrival_slot)) {
      return NextResponse.json({ error: "Invalid arrival_slot" }, { status: 400 });
    }

    const update: Record<string, unknown> = {
      status: "confirmed",
      confirmed_at: new Date().toISOString(),
      confirmed_by: "trade",
    };
    if (!hasExisting && hasSupplied) {
      update.arrival_slot = body.arrival_slot || null;
      update.arrival_time = body.arrival_time || null;
    }

    const { data: updated, error } = await supabase
      .from("trade_visits")
      .update(update)
      .eq("id", visit.id)
      .select()
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ visit: updated });
  }

  if (body.action === "confirm_different_time") {
    if (body.arrival_slot && !VALID_SLOTS.has(body.arrival_slot)) {
      return NextResponse.json({ error: "Invalid arrival_slot" }, { status: 400 });
    }
    if (!body.arrival_slot && !body.arrival_time) {
      return NextResponse.json({ error: "arrival_slot or arrival_time is required" }, { status: 400 });
    }

    const today = new Date().toISOString().slice(0, 10);
    const fyiLine = `[Trade changed arrival time on ${today}]`;
    const nextNotes = [visit.notes?.trim(), fyiLine].filter(Boolean).join("\n");

    const { data: updated, error } = await supabase
      .from("trade_visits")
      .update({
        arrival_slot: body.arrival_slot || null,
        arrival_time: body.arrival_time || null,
        status: "confirmed",
        confirmed_at: new Date().toISOString(),
        confirmed_by: "trade",
        notes: nextNotes,
      })
      .eq("id", visit.id)
      .select()
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ visit: updated });
  }

  if (body.action === "propose") {
    if (!body.proposed_start || !body.proposed_end) {
      return NextResponse.json(
        { error: "proposed_start and proposed_end are required" },
        { status: 400 }
      );
    }
    if (body.proposed_end < body.proposed_start) {
      return NextResponse.json(
        { error: "proposed_end must be on or after proposed_start" },
        { status: 400 }
      );
    }
    if (body.proposed_slot && !VALID_SLOTS.has(body.proposed_slot)) {
      return NextResponse.json({ error: "Invalid proposed_slot" }, { status: 400 });
    }

    const { data: updated, error } = await supabase
      .from("trade_visits")
      .update({
        proposed_start: body.proposed_start,
        proposed_end: body.proposed_end,
        proposed_slot: body.proposed_slot || null,
        proposed_time: body.proposed_time || null,
        proposed_note: body.proposed_note?.trim() || null,
        status: "proposed_change",
      })
      .eq("id", visit.id)
      .select()
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ visit: updated });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
