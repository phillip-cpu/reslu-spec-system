import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };
type GroupActionInput = {
  action?: unknown;
  client_action_id?: unknown;
  title?: unknown;
  profile_ids?: unknown;
  agent_slugs?: unknown;
  profile_id?: unknown;
  agent_slug?: unknown;
  admin?: unknown;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function groupErrorStatus(message: string): number {
  if (/admin required/i.test(message)) return 403;
  if (/not found|unavailable/i.test(message)) return 404;
  if (/keep at least one admin|only human|use leave group|already used/i.test(message)) return 409;
  if (/must be|invalid|choose|too many|no more than|unauthorized/i.test(message)) return 400;
  return 500;
}

function validProfileIds(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length <= 49
    && value.every((item) => typeof item === "string" && UUID_PATTERN.test(item))
    && new Set(value).size === value.length;
}

function validAgentSlugs(value: unknown): value is Array<"aria" | "marco"> {
  return Array.isArray(value)
    && value.length <= 2
    && value.every((item) => item === "aria" || item === "marco")
    && new Set(value).size === value.length;
}

export async function PATCH(request: NextRequest, context: Context) {
  const { id } = await context.params;
  if (!UUID_PATTERN.test(id)) {
    return NextResponse.json({ error: "Invalid conversation" }, { status: 400 });
  }
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rawBody = await request.json().catch(() => null);
  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const body = rawBody as GroupActionInput;
  if (typeof body.client_action_id !== "string" || !UUID_PATTERN.test(body.client_action_id)) {
    return NextResponse.json({ error: "A valid client action ID is required" }, { status: 400 });
  }
  let result: unknown;
  let error: { message: string } | null = null;

  if (body.action === "rename") {
    if (typeof body.title !== "string" || !body.title.trim() || body.title.trim().length > 200) {
      return NextResponse.json({ error: "Group name must be between 1 and 200 characters" }, { status: 400 });
    }
    const response = await supabase.rpc("rename_conversation_group", {
      p_conversation_id: id,
      p_title: body.title,
      p_client_action_id: body.client_action_id,
    });
    result = response.data;
    error = response.error;
  } else if (body.action === "add") {
    const profileIds = body.profile_ids ?? [];
    const agentSlugs = body.agent_slugs ?? [];
    if (!validProfileIds(profileIds) || !validAgentSlugs(agentSlugs) || profileIds.length + agentSlugs.length < 1) {
      return NextResponse.json({ error: "Choose unique available participants" }, { status: 400 });
    }
    const response = await supabase.rpc("add_conversation_group_participants", {
      p_conversation_id: id,
      p_profile_ids: profileIds,
      p_agent_slugs: agentSlugs,
      p_client_action_id: body.client_action_id,
    });
    result = response.data;
    error = response.error;
  } else if (body.action === "role") {
    if (typeof body.profile_id !== "string" || !UUID_PATTERN.test(body.profile_id) || typeof body.admin !== "boolean") {
      return NextResponse.json({ error: "Choose a valid human participant and role" }, { status: 400 });
    }
    const response = await supabase.rpc("set_conversation_group_admin", {
      p_conversation_id: id,
      p_profile_id: body.profile_id,
      p_admin: body.admin,
      p_client_action_id: body.client_action_id,
    });
    result = response.data;
    error = response.error;
  } else if (body.action === "remove") {
    const profileId = body.profile_id == null ? null : body.profile_id;
    const agentSlug = body.agent_slug == null ? null : body.agent_slug;
    const validProfile = profileId == null || (typeof profileId === "string" && UUID_PATTERN.test(profileId));
    const validAgent = agentSlug == null || agentSlug === "aria" || agentSlug === "marco";
    if (!validProfile || !validAgent || Number(profileId != null) + Number(agentSlug != null) !== 1) {
      return NextResponse.json({ error: "Choose one valid participant to remove" }, { status: 400 });
    }
    const response = await supabase.rpc("remove_conversation_group_participant", {
      p_conversation_id: id,
      p_profile_id: profileId,
      p_agent_slug: agentSlug,
      p_client_action_id: body.client_action_id,
    });
    result = response.data;
    error = response.error;
  } else if (body.action === "leave") {
    const response = await supabase.rpc("leave_conversation_group", {
      p_conversation_id: id,
      p_client_action_id: body.client_action_id,
    });
    result = response.data;
    error = response.error;
  } else {
    return NextResponse.json({ error: "Invalid group action" }, { status: 400 });
  }

  if (error) return NextResponse.json({ error: error.message }, { status: groupErrorStatus(error.message) });
  return NextResponse.json({ ok: true, result });
}
