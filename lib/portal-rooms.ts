import type { SupabaseClient } from "@supabase/supabase-js";
import type { PortalItemRoom } from "@/app/portal/types";

/**
 * Bug fix (7 July 2026): the portal's room-grouping (Awaiting/Flagged
 * list, "Your selections" gallery, the client-area Board) and the
 * "Approve all in this room" bulk action were all built against
 * items.location — a field that stopped being the source of truth
 * once Rooms became the primary grouping concept (see the Spec
 * register's own "Group by Room" panel, which already reads
 * item_rooms, not location). Most items now have location = null,
 * so every portal room section collapsed into one "Other" bucket, and
 * "Approve all N in this room" for that bucket queried
 * `.eq("location", "Other")` — a string that's never actually stored
 * on any row — silently approving zero items despite the confirm
 * dialog claiming N would be approved.
 *
 * This is the one shared place both portal pages fetch an item's
 * real room assignment(s) from item_rooms, mirroring the internal
 * spec register's own room-join query (GET /api/projects/[id]/items/
 * rooms) — an item can be in zero, one, or several rooms; zero rooms
 * is a real, valid state ("Unassigned"), not an error.
 */
export async function fetchItemRoomsMap(
  supabase: SupabaseClient,
  projectId: string,
  itemIds: string[]
): Promise<Map<string, PortalItemRoom[]>> {
  const map = new Map<string, PortalItemRoom[]>();
  if (itemIds.length === 0) return map;

  const { data: rooms } = await supabase
    .from("rooms")
    .select("id,name")
    .eq("project_id", projectId)
    .is("deleted_at", null);
  const roomNameById = new Map((rooms ?? []).map((r) => [r.id as string, r.name as string]));

  const { data: itemRooms } = await supabase
    .from("item_rooms")
    .select("item_id,room_id")
    .in("item_id", itemIds);

  for (const row of itemRooms ?? []) {
    const name = roomNameById.get(row.room_id);
    if (!name) continue; // room deleted/out of project — skip rather than show a blank label
    const list = map.get(row.item_id) ?? [];
    list.push({ id: row.room_id, name });
    map.set(row.item_id, list);
  }

  return map;
}
