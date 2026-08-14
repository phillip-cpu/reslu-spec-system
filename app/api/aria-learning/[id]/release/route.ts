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
  if (actor.role !== "admin") return NextResponse.json({ error: "Accountable release operator required" }, { status: 403 });
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  const { data, error } = await supabase.rpc("release_aria_learning_candidate", {
    p_candidate_id: id,
    p_release_version: body.release_version,
    p_previous_version: body.previous_version,
    p_previous_artifact_sha256: body.previous_artifact_sha256,
    p_deployment_receipt_ref: body.deployment_receipt_ref,
    p_monitoring_plan: body.monitoring_plan,
  }).single();
  if (error || !data) return NextResponse.json({ error: error?.message ?? "Release failed" }, { status: 400 });
  return NextResponse.json({ release: data });
}
