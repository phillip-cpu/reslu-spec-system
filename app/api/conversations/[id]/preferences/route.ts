import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };
type PreferenceInput = {
  notifications_muted?: unknown;
  archived?: unknown;
  pinned?: unknown;
};

export async function PATCH(request: NextRequest, context: Context) {
  const { id: conversationId } = await context.params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => null) as PreferenceInput | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  for (const [key, value] of Object.entries(body)) {
    if (!["notifications_muted", "archived", "pinned"].includes(key) || typeof value !== "boolean") {
      return NextResponse.json({ error: "Preferences must be boolean mute, archive or pin values" }, { status: 400 });
    }
  }
  if (Object.keys(body).length === 0) {
    return NextResponse.json({ error: "Choose a preference to change" }, { status: 400 });
  }

  const { data, error } = await supabase.rpc("update_conversation_preferences", {
    p_conversation_id: conversationId,
    p_notifications_muted: typeof body.notifications_muted === "boolean" ? body.notifications_muted : null,
    p_archived: typeof body.archived === "boolean" ? body.archived : null,
    p_pinned: typeof body.pinned === "boolean" ? body.pinned : null,
  }).single();
  if (error || !data) {
    const missing = /not found/i.test(error?.message ?? "");
    return NextResponse.json({ error: missing ? "Conversation not found" : error?.message ?? "Could not update conversation" }, { status: missing ? 404 : 500 });
  }

  return NextResponse.json({ preferences: data });
}
