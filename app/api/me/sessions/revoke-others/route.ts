import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const MAX_PUSH_ENDPOINT_LENGTH = 4096;

/**
 * Revokes every refreshable RESLU login except the caller's current session.
 * Push routes for those other browser installs are removed separately so a
 * signed-out phone cannot keep receiving private-notification wakeups.
 *
 * Supabase access tokens are short-lived JWTs. Revoking a session prevents it
 * from refreshing, but an already-issued access token may remain valid until
 * its expiry. The client states that boundary rather than claiming an instant
 * remote wipe that the authentication provider does not perform.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return NextResponse.json({ error: "Invalid session revocation request" }, { status: 400 });
  }
  const endpointValue = (raw as { current_push_endpoint?: unknown }).current_push_endpoint;
  if (endpointValue !== undefined && endpointValue !== null && typeof endpointValue !== "string") {
    return NextResponse.json({ error: "Invalid current push endpoint" }, { status: 400 });
  }
  const currentPushEndpoint = typeof endpointValue === "string" ? endpointValue.trim() : null;
  if (currentPushEndpoint && (
    currentPushEndpoint.length > MAX_PUSH_ENDPOINT_LENGTH
    || !URL.canParse(currentPushEndpoint)
    || new URL(currentPushEndpoint).protocol !== "https:"
  )) {
    return NextResponse.json({ error: "Invalid current push endpoint" }, { status: 400 });
  }

  const { error: signOutError } = await supabase.auth.signOut({ scope: "others" });
  if (signOutError) {
    return NextResponse.json({ error: "Other sessions could not be revoked" }, { status: 502 });
  }

  let pushDelete = supabase
    .from("push_subscriptions")
    .delete()
    .eq("user_id", user.id);
  if (currentPushEndpoint) pushDelete = pushDelete.neq("endpoint", currentPushEndpoint);
  const { error: pushError } = await pushDelete;
  if (pushError) {
    return NextResponse.json({
      error: "Other sessions were revoked, but notification routes could not all be removed. Retry this action.",
      sessions_revoked: true,
    }, { status: 502 });
  }

  return NextResponse.json({
    ok: true,
    current_session_retained: true,
    other_push_routes_removed: true,
  });
}
