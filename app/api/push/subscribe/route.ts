import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { PushSubscriptionJsonInput } from "@/types/health-push";

export const runtime = "nodejs";

/**
 * POST /api/push/subscribe
 *
 * Health + web push round (r26), BUILD-SPEC.md item 2: "subscribe/
 * unsubscribe toggle in Settings; store subscription per user." Called
 * from components/settings/PushSettings.tsx with the browser's
 * `PushSubscription.toJSON()` after a successful
 * `registration.pushManager.subscribe(...)`.
 *
 * Cookie-session auth (this is a browser call, not a mini/MCP one) —
 * upserts by endpoint (unique per migration 053) so re-subscribing the
 * same browser (e.g. after clearing the toggle off/on) updates the
 * existing row rather than erroring on the unique constraint.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: PushSubscriptionJsonInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
    return NextResponse.json({ error: "endpoint, keys.p256dh, keys.auth are required." }, { status: 400 });
  }

  const { data: subscription, error } = await supabase
    .from("push_subscriptions")
    .upsert(
      {
        user_id: user.id,
        endpoint: body.endpoint,
        p256dh: body.keys.p256dh,
        auth: body.keys.auth,
      },
      { onConflict: "endpoint" }
    )
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, subscription });
}
