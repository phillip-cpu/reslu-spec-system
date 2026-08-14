import { NextRequest, NextResponse } from "next/server";
import { payloadSha256, verificationFromResult } from "@/lib/aria-authority";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: { action_run_id?: unknown; result?: unknown; error_code?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  if (typeof body.action_run_id !== "string") return NextResponse.json({ error: "action_run_id is required" }, { status: 400 });

  const { data: run, error: runError } = await supabase
    .from("aria_action_runs")
    .select("id,tool_name")
    .eq("id", body.action_run_id)
    .single();
  if (runError || !run) return NextResponse.json({ error: "Action run not found" }, { status: 404 });
  const { data: policy, error: policyError } = await supabase
    .from("aria_tool_registry")
    .select("verification_kind")
    .eq("tool_name", run.tool_name)
    .single();
  if (policyError || !policy) return NextResponse.json({ error: "Tool policy not found" }, { status: 409 });

  const errorCode = typeof body.error_code === "string" ? body.error_code.slice(0, 120) : "";
  const failed = errorCode.length > 0;
  const verification = failed
    ? {
        outcome: "failed" as const,
        receipt_ref: null,
        result_sha256: payloadSha256({ error_code: errorCode }),
        resulting_version: null,
        verification_kind: "none",
        verification_evidence: { error_code: errorCode },
      }
    : verificationFromResult(run.tool_name, policy.verification_kind, body.result);

  const { data, error } = await supabase.rpc("finish_aria_action", {
    p_action_run_id: run.id,
    p_outcome: verification.outcome,
    p_receipt_ref: verification.receipt_ref,
    p_result_sha256: verification.result_sha256,
    p_resulting_version: verification.resulting_version,
    p_verification_kind: verification.verification_kind,
    p_verification_evidence: verification.verification_evidence,
    p_failure_code: failed ? errorCode : null,
  }).single();
  if (error || !data) return NextResponse.json({ error: error?.message ?? "Could not record action outcome" }, { status: 400 });
  return NextResponse.json({ receipt: data });
}
