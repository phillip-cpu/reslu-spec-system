import { NextRequest, NextResponse } from "next/server";
import { deriveActionTarget, payloadSha256 } from "@/lib/aria-authority";
import { getUserRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const actor = await getUserRole(supabase);
  if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (actor.role !== "admin") return NextResponse.json({ error: "Administrator approval required" }, { status: 403 });
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  const toolName = typeof body.tool_name === "string" ? body.tool_name : "";
  const toolArgs = body.tool_args && typeof body.tool_args === "object" && !Array.isArray(body.tool_args)
    ? body.tool_args as Record<string, unknown>
    : null;
  const idempotencyKey = typeof body.idempotency_key === "string" ? body.idempotency_key : "";
  const scope = typeof body.approval_scope === "string" ? body.approval_scope : "";
  if (!toolName || !toolArgs || !idempotencyKey || !scope) {
    return NextResponse.json({ error: "Exact tool, args, idempotency key, and approval scope are required" }, { status: 400 });
  }
  const target = deriveActionTarget(toolName, toolArgs);
  const expiryMinutes = typeof body.expiry_minutes === "number" ? body.expiry_minutes : 30;
  if (!Number.isInteger(expiryMinutes) || expiryMinutes < 1 || expiryMinutes > 1440) {
    return NextResponse.json({ error: "expiry_minutes must be between 1 and 1440" }, { status: 400 });
  }
  const expiresAt = new Date(Date.now() + expiryMinutes * 60_000).toISOString();
  const { data, error } = await supabase.rpc("issue_aria_approval_receipt", {
    p_tool_name: toolName,
    p_target_type: target.target_type,
    p_target_id: target.target_id,
    p_payload_sha256: payloadSha256(toolArgs),
    p_expected_version: typeof body.expected_version === "string" ? body.expected_version : null,
    p_idempotency_key: idempotencyKey,
    p_approval_scope: scope,
    p_expires_at: expiresAt,
    p_domain_review_ref: typeof body.domain_review_ref === "string" ? body.domain_review_ref : null,
  }).single();
  if (error || !data) return NextResponse.json({ error: error?.message ?? "Approval could not be issued" }, { status: 400 });
  return NextResponse.json({ approval: data, effect: { tool_name: toolName, target, payload_sha256: payloadSha256(toolArgs) } });
}
