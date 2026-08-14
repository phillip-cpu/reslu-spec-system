import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const [candidates, modules, enrolments] = await Promise.all([
    supabase.from("aria_learning_candidates").select("*").order("created_at", { ascending: false }).limit(100),
    supabase.from("aria_learning_modules").select("*").eq("active", true).order("week_start"),
    supabase.from("aria_learning_enrolments").select("*").order("created_at"),
  ]);
  const error = candidates.error ?? modules.error ?? enrolments.error;
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ candidates: candidates.data ?? [], modules: modules.data ?? [], enrolments: enrolments.data ?? [] });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  const { data, error } = await supabase.rpc("create_aria_learning_candidate", {
    p_candidate_key: body.candidate_key,
    p_question: body.question,
    p_trigger_type: body.trigger_type,
    p_trigger_summary: body.trigger_summary,
    p_affected_assets: body.affected_assets,
    p_proposed_change_summary: body.proposed_change_summary,
    p_proposed_version: body.proposed_version,
    p_artifact_ref: body.artifact_ref,
    p_artifact_sha256: body.artifact_sha256,
    p_risk_tier: body.risk_tier,
    p_owner_profile_id: body.owner_profile_id ?? null,
    p_review_by: body.review_by,
    p_expires_at: body.expires_at,
    p_rollback_plan: body.rollback_plan,
  }).single();
  if (error || !data) return NextResponse.json({ error: error?.message ?? "Could not create learning candidate" }, { status: 400 });
  return NextResponse.json({ candidate: data }, { status: 201 });
}
