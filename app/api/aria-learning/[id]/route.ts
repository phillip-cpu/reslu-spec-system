import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, context: Context) {
  const { id } = await context.params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  const action = body.action;
  let query;
  if (action === "add_source") {
    query = supabase.rpc("add_aria_learning_source", { p_candidate_id: id, p_source: body.source });
  } else if (action === "record_eval") {
    const evalResult = (body.eval_result ?? {}) as Record<string, unknown>;
    query = supabase.rpc("record_aria_learning_eval", {
      p_candidate_id: id,
      p_run_id: evalResult.run_id,
      p_suite_id: evalResult.suite_id,
      p_artifact_ref: evalResult.artifact_ref,
      p_artifact_sha256: evalResult.artifact_sha256,
      p_candidate_artifact_sha256: evalResult.candidate_artifact_sha256,
      p_hard_gates_passed: evalResult.hard_gates_passed,
      p_critical_regressions: evalResult.critical_regressions,
      p_human_review_status: evalResult.human_review_status,
      p_trajectory_status: evalResult.trajectory_status,
      p_completed_at: evalResult.completed_at,
    });
  } else if (action === "request_review") {
    query = supabase.rpc("request_aria_learning_review", { p_candidate_id: id });
  } else if (action === "stage") {
    query = supabase.rpc("stage_aria_learning_candidate", { p_candidate_id: id });
  } else if (action === "record_monitor") {
    const monitor = (body.monitor ?? {}) as Record<string, unknown>;
    query = supabase.rpc("record_aria_learning_monitor", {
      p_candidate_id: id,
      p_release_id: monitor.release_id,
      p_metric_key: monitor.metric_key,
      p_metric_value: monitor.metric_value,
      p_status: monitor.status,
      p_evidence_ref: monitor.evidence_ref,
      p_evidence_sha256: monitor.evidence_sha256,
      p_observed_at: monitor.observed_at,
    });
  } else {
    return NextResponse.json({ error: "Unsupported learning action" }, { status: 400 });
  }
  const { data, error } = await query.single();
  if (error || !data) return NextResponse.json({ error: error?.message ?? "Learning action failed" }, { status: 400 });
  return NextResponse.json({ result: data });
}
