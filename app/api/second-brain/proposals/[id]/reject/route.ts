import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * POST /api/second-brain/proposals/[id]/reject
 *
 * RESLU Second Brain, Step 11 (docs/RESLU-second-brain-build-brief.md).
 * Marks a pending proposal rejected — never touches items. Does NOT
 * itself write to entity_aliases/email_entity_matches: if a rejection
 * is really "wrong item was matched, not wrong price", that's a
 * separate, explicit call to Step 10's own correction route
 * (POST /api/second-brain/matches/[id]/correct), not something this
 * route auto-infers from a rejection note it can't reliably parse.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { note?: string } = {};
  try {
    body = await request.json();
  } catch {
    // Empty body is valid — note is optional.
  }

  const { data: updated, error } = await supabase
    .from("change_proposals")
    .update({ status: "rejected", resolved_at: new Date().toISOString(), resolved_by: user.email ?? user.id, note: body.note ?? null })
    .eq("id", id)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!updated) return NextResponse.json({ error: "Proposal not found or not pending" }, { status: 404 });

  await supabase
    .from("aria_queue")
    .update({ status: "done", resolved_at: new Date().toISOString(), note: body.note ?? null })
    .eq("dedupe_key", `email_proposal:${id}`);

  return NextResponse.json({ ok: true });
}
