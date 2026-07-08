import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * POST /api/second-brain/proposals/[id]/approve
 *
 * RESLU Second Brain, Step 11 (docs/RESLU-second-brain-build-brief.md).
 * Thin wrapper around approve_proposal() (migration 040), which does
 * the actual atomic write (items.{field} + audit_log, one
 * transaction) — no business logic here beyond resolving the paired
 * aria_queue row afterward.
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

  const { data, error } = await supabase.rpc("approve_proposal", { p_id: id, p_resolved_by: user.email ?? user.id });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  await supabase
    .from("aria_queue")
    .update({ status: "done", resolved_at: new Date().toISOString() })
    .eq("dedupe_key", `email_proposal:${id}`);

  return NextResponse.json({ ok: true, result: data?.[0] ?? null });
}
