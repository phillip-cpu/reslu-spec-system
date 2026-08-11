import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, context: Context) {
  const { id: conversationId } = await context.params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => null) as { through_message_id?: unknown } | null;
  const throughMessageId = body?.through_message_id;
  if (typeof throughMessageId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(throughMessageId)) {
    return NextResponse.json({ error: "Valid through_message_id is required" }, { status: 400 });
  }

  const { data: lastReadAt, error } = await supabase.rpc("mark_conversation_read", {
    p_conversation_id: conversationId,
    p_through_message_id: throughMessageId,
  });
  if (error) {
    const missing = /not found/i.test(error.message);
    return NextResponse.json({ error: missing ? "Conversation message not found" : error.message }, { status: missing ? 404 : 500 });
  }

  return NextResponse.json({ last_read_at: lastReadAt });
}
