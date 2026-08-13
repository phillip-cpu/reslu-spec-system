import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };
type DelegationBody = {
  target_agent?: unknown;
  delegation_id?: unknown;
  title?: unknown;
  objective?: unknown;
  model_tier?: unknown;
  source_task_id?: unknown;
};

const ID = /^[A-Za-z0-9_-]{1,160}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function text(value: unknown, maximum: number) {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  return cleaned && cleaned.length <= maximum ? cleaned : null;
}

export async function POST(request: NextRequest, context: Context) {
  const { id } = await context.params;
  let body: DelegationBody;
  try {
    body = await request.json() as DelegationBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const targetAgent = body.target_agent === "aria" || body.target_agent === "marco" || body.target_agent === "stuart"
    ? body.target_agent
    : null;
  const delegationId = text(body.delegation_id, 160);
  const title = text(body.title, 200);
  const objective = text(body.objective, 20_000);
  const modelTier = body.model_tier === "fast" || body.model_tier === "strong" ? body.model_tier : "standard";
  const sourceTaskId = body.source_task_id == null ? null : text(body.source_task_id, 160);

  if (!targetAgent || !delegationId || !ID.test(delegationId) || !title || !objective
    || (sourceTaskId !== null && !UUID.test(sourceTaskId))) {
    return NextResponse.json({ error: "Invalid inter-agent delegation request" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase.rpc("delegate_conversation_agent_task", {
    p_conversation_id: id,
    p_target_agent_slug: targetAgent,
    p_client_delegation_id: delegationId,
    p_title: title,
    p_objective: objective,
    p_model_tier: modelTier,
    p_source_task_id: sourceTaskId,
  });

  if (error || !data) {
    const message = error?.message ?? "Could not delegate specialist work";
    const status = /required|not found/i.test(message) ? 403
      : /invalid|itself|limit|conflict/i.test(message) ? 409
      : 500;
    return NextResponse.json({ error: message }, { status });
  }

  return NextResponse.json({ task: data }, { status: 201 });
}
