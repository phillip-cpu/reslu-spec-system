import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import type { LatestUnreadNotificationResponse } from "@/types/health-push";

export const runtime = "nodejs";

/**
 * GET /api/notifications/latest-unread
 *
 * Health + web push round (r26), BUILD-SPEC.md item 2: the route
 * public/sw.js's 'push' handler fetches on every payload-less push, to
 * find out what to actually show. Cookie-session auth — the service
 * worker's fetch runs with `credentials: 'same-origin'`, so the same
 * session cookie any other page load on this origin carries is sent
 * automatically; this route reads it exactly like every other
 * server-rendered/authenticated route (lib/supabase/server.ts's
 * createClient()), nothing push-specific about the auth here at all.
 *
 * Visibility: notifications.user_id is either a specific user (none of
 * this round's routes populate that shape yet) or null (all-admins —
 * every kind this round actually fires). A non-admin caller only ever
 * sees rows addressed to THEM specifically (user_id = their own id);
 * they never see the null/"all-admins" rows, matching
 * sendPushToAdmins' own admin-only targeting (lib/push.ts) — a non-
 * admin who enables push in Settings simply never has anything to
 * fetch here, which is fine, nothing pushes to them either.
 *
 * Marks the returned row read_at=now() (if not already) as it's
 * fetched — this IS the "seen" signal (there's no separate
 * notifications inbox UI in this round to click something in) and,
 * practically, stops an unrelated later push (e.g. a heartbeat-driven
 * one that doesn't itself carry new content) from re-showing the SAME
 * stale notification a second time.
 */
export async function GET() {
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let query = supabase
    .from("notifications")
    .select("id,title,body,link_href,kind")
    .is("read_at", null)
    .order("created_at", { ascending: false })
    .limit(1);

  query = info.role === "admin" ? query.or(`user_id.eq.${info.userId},user_id.is.null`) : query.eq("user_id", info.userId);

  const { data: row } = await query.maybeSingle();

  if (row) {
    await supabase.from("notifications").update({ read_at: new Date().toISOString() }).eq("id", row.id).is("read_at", null);
  }

  const response: LatestUnreadNotificationResponse = {
    notification: row ? { id: row.id, title: row.title, body: row.body, link_href: row.link_href } : null,
  };
  return NextResponse.json(response);
}
