import { NextRequest, NextResponse } from "next/server";
import { conversationParticipants } from "@/lib/conversation-access";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string; messageId: string }> };
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function PATCH(request: NextRequest, context: Context) {
  const { id, messageId } = await context.params;
  if (!UUID_PATTERN.test(id) || !UUID_PATTERN.test(messageId)) {
    return NextResponse.json({ error: "Invalid message" }, { status: 400 });
  }
  const rawBody = await request.json().catch(() => null) as { pinned?: unknown } | null;
  if (typeof rawBody?.pinned !== "boolean") {
    return NextResponse.json({ error: "Pinned state is required" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const membership = await conversationParticipants(supabase, id, user.id);
  const self = membership.participants.some((participant) => participant.type === "human" && participant.id === user.id);
  if (membership.error || !self) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });

  const { error } = await supabase.rpc("set_conversation_message_pinned", {
    p_conversation_id: id,
    p_message_id: messageId,
    p_pinned: rawBody.pinned,
  });
  if (error) {
    const status = /not found/i.test(error.message) ? 404 : /no more than five/i.test(error.message) ? 409 : 500;
    return NextResponse.json({ error: error.message }, { status });
  }

  const { data: pin, error: pinError } = await supabase
    .from("conversation_message_pins")
    .select("pinned_at,pinned_by")
    .eq("conversation_id", id)
    .eq("message_id", messageId)
    .maybeSingle();
  if (pinError) return NextResponse.json({ error: "Could not refresh pinned state" }, { status: 503 });
  return NextResponse.json({
    pinned_at: pin?.pinned_at ?? null,
    pinned_by: pin?.pinned_by ?? null,
  });
}
