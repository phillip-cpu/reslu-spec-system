import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };
type AgentSlug = "aria" | "marco" | "stuart";
type ModelTier = "fast" | "standard" | "strong";

function text(value: unknown, max: number) {
  return typeof value === "string" && value.trim() && value.trim().length <= max
    ? value.trim()
    : null;
}

export async function POST(request: NextRequest, context: Context) {
  const { id: conversationId } = await context.params;
  let raw: unknown;
  try { raw = await request.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!raw || typeof raw !== "object") {
    return NextResponse.json({ error: "Invalid delegation request" }, { status: 400 });
  }
  const body = raw as Record<string, unknown>;
  const targetAgent = body.target_agent as AgentSlug;
  const delegationId = text(body.delegation_id, 160);
  const title = text(body.title, 200);
  const objective = text(body.objective, 20_000);
  const modelTier = (body.model_tier ?? "standard") as ModelTier;
  const sourceTaskId = typeof body.source_task_id === "string" && body.source_task_id.trim()
    ? body.source_task_id.trim()
    : null;
  if (!["aria", "marco", "stuart"].includes(targetAgent) || !delegationId || !title || !objective
    || !["fast", "standard", "strong"].includes(modelTier)) {
    return NextResponse.json({ error: "Invalid delegation request" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceRoleClient();
  const { data: sourceAgent, error: sourceError } = await service
    .from("conversation_agents")
    .select("id,slug")
    .eq("auth_profile_id", user.id)
    .maybeSingle();
  if (sourceError) return NextResponse.json({ error: sourceError.message }, { status: 500 });
  if (!sourceAgent) return NextResponse.json({ error: "Only a configured RESLU agent may delegate work" }, { status: 403 });
  if (sourceAgent.slug === targetAgent) {
    return NextResponse.json({ error: "An agent cannot delegate work to itself" }, { status: 400 });
  }

  const [{ data: membership, error: membershipError }, { data: target, error: targetError }] = await Promise.all([
    service.from("conversation_participants").select("conversation_id").eq("conversation_id", conversationId).eq("agent_id", sourceAgent.id).maybeSingle(),
    service.from("conversation_agents").select("id,slug").eq("slug", targetAgent).maybeSingle(),
  ]);
  if (membershipError || targetError) {
    return NextResponse.json({ error: membershipError?.message ?? targetError?.message }, { status: 500 });
  }
  if (!membership || !target) return NextResponse.json({ error: "Conversation or specialist not found" }, { status: 404 });

  if (sourceTaskId) {
    const { data: sourceTask, error: taskError } = await service
      .from("agent_tasks")
      .select("id")
      .eq("id", sourceTaskId)
      .eq("conversation_id", conversationId)
      .eq("owner_agent_id", sourceAgent.id)
      .maybeSingle();
    if (taskError) return NextResponse.json({ error: taskError.message }, { status: 500 });
    if (!sourceTask) return NextResponse.json({ error: "Source task not found" }, { status: 400 });
  }

  const clientTaskId = `delegate:${sourceAgent.slug}:${delegationId}`;
  const { data: existing, error: existingError } = await service
    .from("agent_tasks")
    .select("*")
    .eq("conversation_id", conversationId)
    .eq("client_task_id", clientTaskId)
    .maybeSingle();
  if (existingError) return NextResponse.json({ error: existingError.message }, { status: 500 });
  if (existing) {
    const sameIntent = existing.owner_agent_id === target.id
      && existing.delegated_by_agent_id === sourceAgent.id
      && existing.source_task_id === sourceTaskId
      && existing.title === title
      && existing.objective === objective
      && existing.model_tier === modelTier;
    if (!sameIntent) return NextResponse.json({ error: "This delegation id was already used for different work" }, { status: 409 });
    return NextResponse.json({ task: existing });
  }

  const { data: task, error } = await service.from("agent_tasks").insert({
    conversation_id: conversationId,
    requested_by: user.id,
    owner_agent_id: target.id,
    delegated_by_agent_id: sourceAgent.id,
    source_task_id: sourceTaskId,
    client_task_id: clientTaskId,
    title,
    objective,
    requested_via: "system",
    model_tier: modelTier,
  }).select("*").single();
  if (error || !task) return NextResponse.json({ error: error?.message ?? "Could not delegate work" }, { status: 500 });
  return NextResponse.json({ task }, { status: 201 });
}
