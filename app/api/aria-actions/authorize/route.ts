import { NextRequest, NextResponse } from "next/server";
import { deriveActionTarget, payloadSha256, validatedAuthorityEnvelope } from "@/lib/aria-authority";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { tool_name?: unknown; tool_args?: unknown; authority?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  if (typeof body.tool_name !== "string" || !body.tool_args || typeof body.tool_args !== "object" || Array.isArray(body.tool_args)) {
    return NextResponse.json({ error: "tool_name and tool_args are required" }, { status: 400 });
  }

  try {
    const authority = validatedAuthorityEnvelope(body.authority);
    const toolArgs = body.tool_args as Record<string, unknown>;
    const target = deriveActionTarget(body.tool_name, toolArgs, authority);
    const { data, error } = await supabase.rpc("begin_aria_action", {
      p_tool_name: body.tool_name,
      p_target_type: target.target_type,
      p_target_id: target.target_id,
      p_request_id: authority.request_id,
      p_correlation_id: authority.correlation_id,
      p_idempotency_key: authority.idempotency_key,
      p_payload_sha256: payloadSha256(toolArgs),
      p_expected_version: authority.expected_version ?? null,
      p_expected_absent: authority.expected_absent ?? false,
      p_approval_receipt_id: authority.approval_receipt_id ?? null,
      p_metadata: { transport: "mcp", api_version: "aria-authority-v1" },
    }).single();
    if (error || !data) return NextResponse.json({ error: error?.message ?? "Action was not authorised" }, { status: 403 });
    return NextResponse.json({ action: data, target, payload_sha256: payloadSha256(toolArgs) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid authority envelope" }, { status: 400 });
  }
}
