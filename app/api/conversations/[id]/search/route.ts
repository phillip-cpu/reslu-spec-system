import { NextRequest, NextResponse } from "next/server";
import { conversationParticipants } from "@/lib/conversation-access";
import { messageAuthor } from "@/lib/conversations";
import { createClient } from "@/lib/supabase/server";
import type { ConversationMessage } from "@/types/conversations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: Context) {
  const { id: conversationId } = await context.params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const query = request.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (query.length < 2) {
    return NextResponse.json({ error: "Search must contain at least 2 characters" }, { status: 400 });
  }
  if (query.length > 100) {
    return NextResponse.json({ error: "Search is too long" }, { status: 400 });
  }

  const participantResult = await conversationParticipants(supabase, conversationId, user.id);
  if (participantResult.error) {
    return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
  }

  const { data, error } = await supabase.rpc("search_conversation_messages", {
    p_conversation_id: conversationId,
    p_query: query,
    p_limit: 50,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (data ?? []) as unknown as Array<Omit<ConversationMessage, "attachments" | "author">>;
  const results = rows.map((message) => ({
    ...message,
    metadata: message.metadata ?? {},
    attachments: [],
    author: messageAuthor(message, participantResult.participants),
  })) as ConversationMessage[];

  return NextResponse.json({ results });
}
