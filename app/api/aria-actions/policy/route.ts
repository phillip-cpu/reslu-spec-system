import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data, error } = await supabase
    .from("aria_tool_registry")
    .select("tool_name,risk_tier,action_class,approval_rule,verification_kind,idempotency_kind,rollback_kind")
    .eq("active", true)
    .contains("allowed_agent_slugs", ["aria"])
    .order("tool_name");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ schema_version: "aria-authority-v1", tools: data ?? [] });
}
