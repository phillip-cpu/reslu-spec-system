import { NextRequest, NextResponse } from "next/server";
import { syncAriaActions } from "@/lib/aria-actions";
import { getUserRole } from "@/lib/auth";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/** Manual/cron-safe Phase 4 retry. Normal operation runs this once from
 * each deduplicated daily/weekly routine; this route exists so an admin
 * can deliberately retry a partial sync without manufacturing a second
 * routine row. */
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const isCronCall =
    !!cronSecret && request.headers.get("authorization") === `Bearer ${cronSecret}`;
  if (!isCronCall) {
    const supabase = await createClient();
    const info = await getUserRole(supabase);
    if (!info) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (info.role !== "admin") {
      return NextResponse.json({ error: "Only admins can run the Aria action sync" }, { status: 403 });
    }
  }

  try {
    const summary = await syncAriaActions(createServiceRoleClient());
    return NextResponse.json({ ok: summary.errors.length === 0, summary });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Phase 4 action sync failed" },
      { status: 500 }
    );
  }
}
