import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { LatestUnreadNotificationResponse } from "@/types/health-push";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  const { id } = await context.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    return NextResponse.json({ error: "Notification not found" }, { status: 404 });
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Migration 095 RLS restricts this exact-id lookup to its owner (or an
  // all-admin row for an admin). Fetching for display does not mark it read;
  // conversation read state advances only when the user opens that thread.
  const { data: row } = await supabase
    .from("notifications")
    .select("id,title,body,link_href,kind")
    .eq("id", id)
    .maybeSingle();
  if (!row) return NextResponse.json({ error: "Notification not found" }, { status: 404 });

  const response: LatestUnreadNotificationResponse = {
    notification: {
      id: row.id,
      tag: row.kind.startsWith("conversation_message:") ? row.kind : row.id,
      title: row.title,
      body: row.body,
      link_href: row.link_href,
    },
  };
  return NextResponse.json(response);
}
