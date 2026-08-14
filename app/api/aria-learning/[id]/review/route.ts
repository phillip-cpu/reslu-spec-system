import { NextRequest, NextResponse } from "next/server";
import { getUserRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, context: Context) {
  const { id } = await context.params;
  const supabase = await createClient();
  const actor = await getUserRole(supabase);
  if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (actor.role !== "admin") return NextResponse.json({ error: "Administrator review required" }, { status: 403 });
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  const { data, error } = await supabase.rpc("decide_aria_learning_candidate", {
    p_candidate_id: id,
    p_approved: body.decision === "approved",
    p_scope: body.scope,
    p_expires_at: body.expires_at,
    p_note: body.note ?? null,
  }).single();
  if (error || !data) return NextResponse.json({ error: error?.message ?? "Review failed" }, { status: 400 });
  return NextResponse.json({ candidate: data });
}
