import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { syncItemToMonday } from "@/lib/monday/sync";
import type { Item } from "@/types";

export const runtime = "nodejs";

/**
 * POST /api/monday/sync/[itemId]
 * Manual/retry trigger for the Monday sync (BUILD-SPEC.md §API design:
 * "/api/monday/sync/[itemId] -> 200 { monday_item_id: string }").
 *
 * The automatic path is the fire-and-forget call from
 * app/api/items/[id]/route.ts's PATCH handler when status transitions
 * to 'Ordered' (via next/server's after()). This route exists for
 * cases that need a manual nudge: the automatic sync failed (Monday
 * was down, token was briefly wrong, etc.) and someone wants to retry
 * without re-toggling the item's status, or an item needs re-syncing
 * after project.monday_board_id / project.settings.monday.columns was
 * only just configured.
 *
 * Idempotent the same way the underlying sync is: if the item already
 * has a monday_item_id, this calls change_multiple_column_values
 * (update) rather than creating a duplicate Monday item.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ itemId: string }> }
) {
  const { itemId } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: item, error: itemError } = await supabase
    .from("items")
    .select("*")
    .eq("id", itemId)
    .is("deleted_at", null)
    .single();

  if (itemError || !item) {
    return NextResponse.json({ error: "Item not found" }, { status: 404 });
  }

  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("name,monday_board_id,settings")
    .eq("id", (item as Item).project_id)
    .single();

  if (projectError || !project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  try {
    const result = await syncItemToMonday(item as Item, project);

    if (result.skipped) {
      return NextResponse.json({ skipped: result.skipped });
    }

    if (result.mondayItemId) {
      await supabase
        .from("items")
        .update({
          monday_item_id: result.mondayItemId,
          monday_synced_at: new Date().toISOString(),
        })
        .eq("id", itemId);
    }

    return NextResponse.json({ monday_item_id: result.mondayItemId });
  } catch (err) {
    // Errors: log + write nothing (BUILD-SPEC.md Week 4 task) — but this
    // is a manual/explicit retry route, so unlike the fire-and-forget
    // path we DO report failure back to the caller (as a 502) rather
    // than swallowing it silently; nothing is persisted either way.
    console.error(`[monday sync] item ${itemId} failed:`, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Monday sync failed" },
      { status: 502 }
    );
  }
}
