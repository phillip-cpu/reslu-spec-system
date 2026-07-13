import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * POST /api/push/unsubscribe
 *
 * Health + web push round (r26) — companion to POST /api/push/subscribe.
 * Body: { endpoint }. Deletes the row for the CALLING USER's own
 * subscription only (`.eq("user_id", user.id)` alongside the endpoint
 * match) — a signed-in user can never delete another user's
 * subscription by guessing/replaying an endpoint string, even though
 * RLS itself is permissive team_all (same "API is the real gate"
 * split every other table in this schema uses).
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { endpoint?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.endpoint) {
    return NextResponse.json({ error: "endpoint is required." }, { status: 400 });
  }

  const { error } = await supabase
    .from("push_subscriptions")
    .delete()
    .eq("user_id", user.id)
    .eq("endpoint", body.endpoint);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
