import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string; messageId: string }> };
type ForwardInput = {
  destination_conversation_ids?: unknown;
  client_forward_id?: unknown;
};
type ForwardResult = {
  destination_conversation_id: string;
  forwarded_message_id: string;
  existing: boolean;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function forwardErrorStatus(message: string): number {
  if (/not found/i.test(message)) return 404;
  if (/already used/i.test(message)) return 409;
  if (/choose|unique|too many|unauthorized/i.test(message)) return 400;
  return 500;
}

export async function POST(request: NextRequest, context: Context) {
  const { id, messageId } = await context.params;
  if (!UUID_PATTERN.test(id) || !UUID_PATTERN.test(messageId)) {
    return NextResponse.json({ error: "Invalid message" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rawBody = await request.json().catch(() => null);
  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const body = rawBody as ForwardInput;
  if (!Array.isArray(body.destination_conversation_ids)) {
    return NextResponse.json({ error: "Choose at least one conversation" }, { status: 400 });
  }
  const destinations = body.destination_conversation_ids;
  if (
    destinations.length < 1
    || destinations.length > 10
    || destinations.some((value) => typeof value !== "string" || !UUID_PATTERN.test(value))
    || new Set(destinations).size !== destinations.length
  ) {
    return NextResponse.json({ error: "Choose between 1 and 10 unique conversations" }, { status: 400 });
  }
  if (typeof body.client_forward_id !== "string" || !UUID_PATTERN.test(body.client_forward_id)) {
    return NextResponse.json({ error: "Invalid forwarding request" }, { status: 400 });
  }

  const { data, error } = await supabase.rpc("forward_conversation_message", {
    p_source_conversation_id: id,
    p_source_message_id: messageId,
    p_destination_conversation_ids: destinations,
    p_client_forward_id: body.client_forward_id,
  });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: forwardErrorStatus(error.message) });
  }
  const forwards = (data ?? []) as ForwardResult[];
  if (forwards.length !== destinations.length) {
    return NextResponse.json({ error: "The forwarded messages could not be confirmed" }, { status: 500 });
  }

  return NextResponse.json(
    { forwards },
    { status: forwards.every((item) => item.existing) ? 200 : 201 }
  );
}
