import { NextRequest, NextResponse } from "next/server";
import { conversationParticipants } from "@/lib/conversation-access";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string; messageId: string }> };
const OUTCOMES = new Set(["useful", "needs_work", "finished_elsewhere"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function PUT(request: NextRequest, context: Context) {
  const { id, messageId } = await context.params;
  if (!UUID_PATTERN.test(id) || !UUID_PATTERN.test(messageId)) {
    return NextResponse.json({ error: "Invalid conversation outcome target" }, { status: 400 });
  }
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await conversationParticipants(supabase, id, user.id);
  if (access.error) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });

  let raw: unknown;
  try { raw = await request.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const outcome = "outcome" in raw ? (raw as { outcome?: unknown }).outcome : null;
  const note = "note" in raw ? (raw as { note?: unknown }).note : null;
  if (typeof outcome !== "string" || !OUTCOMES.has(outcome)) {
    return NextResponse.json({ error: "Invalid outcome" }, { status: 400 });
  }
  if (note != null && (typeof note !== "string" || note.trim().length > 1000)) {
    return NextResponse.json({ error: "Outcome note is too long" }, { status: 400 });
  }
  const { data: message, error: messageError } = await supabase
    .from("conversation_messages")
    .select("id")
    .eq("id", messageId)
    .eq("conversation_id", id)
    .not("author_agent_id", "is", null)
    .is("deleted_at", null)
    .maybeSingle();
  if (messageError) return NextResponse.json({ error: messageError.message }, { status: 500 });
  if (!message) return NextResponse.json({ error: "Agent message not found" }, { status: 404 });

  const { data, error } = await supabase
    .from("agent_outcome_feedback")
    .upsert({
      conversation_id: id,
      message_id: messageId,
      profile_id: user.id,
      outcome,
      note: typeof note === "string" ? note.trim() || null : null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "message_id,profile_id" })
    .select("outcome,note,updated_at")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ feedback: data });
}
