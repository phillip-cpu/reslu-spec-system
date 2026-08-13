import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { AgentSlug } from "@/types/conversations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PURPOSE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/;

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const body = raw as Record<string, unknown>;
  const scopeKind = body.scope_kind;
  const scopeId = body.scope_id;
  const purposeKey = body.purpose_key;
  const title = body.title;
  const agentSlug = body.agent_slug;
  const clientConversationId = body.client_conversation_id;

  if ((scopeKind !== "project" && scopeKind !== "lead") || typeof scopeId !== "string" || !UUID_PATTERN.test(scopeId)) {
    return NextResponse.json({ error: "Invalid conversation scope" }, { status: 400 });
  }
  if (typeof purposeKey !== "string" || !PURPOSE_PATTERN.test(purposeKey)) {
    return NextResponse.json({ error: "Invalid conversation purpose" }, { status: 400 });
  }
  if (title != null && (typeof title !== "string" || title.trim().length > 200)) {
    return NextResponse.json({ error: "Invalid conversation title" }, { status: 400 });
  }
  if (agentSlug !== "aria" && agentSlug !== "marco" && agentSlug !== "stuart") {
    return NextResponse.json({ error: "Invalid conversation agent" }, { status: 400 });
  }
  if (typeof clientConversationId !== "string" || !UUID_PATTERN.test(clientConversationId)) {
    return NextResponse.json({ error: "Invalid client conversation id" }, { status: 400 });
  }

  const { data, error } = await supabase.rpc("get_or_create_scoped_conversation", {
    p_scope_kind: scopeKind,
    p_scope_id: scopeId,
    p_purpose_key: purposeKey,
    p_title: typeof title === "string" ? title.trim() || null : null,
    p_agent_slug: agentSlug as AgentSlug,
    p_client_conversation_id: clientConversationId,
  }).single();
  const result = data as { conversation_id: string; existing: boolean } | null;
  if (error || !result) {
    const message = error?.message ?? "Could not create scoped conversation";
    const status = /not found|unavailable|invalid|required|too long/i.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }

  return NextResponse.json(
    { id: result.conversation_id, existing: Boolean(result.existing) },
    { status: result.existing ? 200 : 201 },
  );
}
