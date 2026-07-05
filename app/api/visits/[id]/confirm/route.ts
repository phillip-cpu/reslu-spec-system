import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * POST /api/visits/[id]/confirm
 * Staff "confirm on behalf of trade" — team session, no admin gate
 * (scheduling data, not financial, same reasoning as every other
 * phases/visits route). Sets status='confirmed', confirmed_at=now(),
 * confirmed_by='staff'. No body required. Response: { visit }.
 *
 * Used from the mobile bottom-sheet (components/gantt/VisitBottomSheet.tsx)
 * and the phase edit panel's per-visit row, for the common case where
 * staff already know a trade has verbally confirmed and just need to
 * record it without waiting on the trade to open their link.
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
    .select("id")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!existing) {
    return NextResponse.json({ error: "Visit not found" }, { status: 404 });
  }

  const { data: visit, error } = await supabase
    .from("trade_visits")
    .update({
      status: "confirmed",
      confirmed_at: new Date().toISOString(),
      confirmed_by: "staff",
    })
    .eq("id", id)
    .is("deleted_at", null)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ visit });
}
