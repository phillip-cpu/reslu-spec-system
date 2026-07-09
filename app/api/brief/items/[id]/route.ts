import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import type { DailyBriefItem, PatchBriefItemInput } from "@/types/round-daily-brief";

export const runtime = "nodejs";

/**
 * PATCH /api/brief/items/[id]
 * BUILD-SPEC.md "Daily Brief" routes list: "PATCH /api/brief/items/[id]
 * (tick/untick)." body: PatchBriefItemInput — { status: 'open' | 'done' }.
 *
 * Ticking means "seen/handled" — per this feature's own header
 * comment (migration 041): it NEVER touches the underlying record this
 * item is a reminder about (the booking, the lead, the order, etc.) —
 * this route only ever writes status/acknowledged_at on the brief row
 * itself. Untick (status: 'open') clears acknowledged_at back to null
 * — a plain reversible toggle, matching this codebase's other
 * tick/untick actions (e.g. PATCH /api/office/tasks/[id]'s
 * complete/uncomplete pair) rather than a one-way action.
 *
 * Admin-gated, same as every other /api/brief* route.
 */
export async function PATCH(
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
    return NextResponse.json({ error: "The Daily Brief is admin-only in v1." }, { status: 403 });
  }

  let body: PatchBriefItemInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (body.status !== "open" && body.status !== "done") {
    return NextResponse.json({ error: "status must be 'open' or 'done'" }, { status: 400 });
  }

  const { data: item, error } = await supabase
    .from("daily_brief_items")
    .update({
      status: body.status,
      acknowledged_at: body.status === "done" ? new Date().toISOString() : null,
    })
    .eq("id", id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!item) {
    return NextResponse.json({ error: "Brief item not found" }, { status: 404 });
  }

  return NextResponse.json({ item: item as DailyBriefItem });
}
