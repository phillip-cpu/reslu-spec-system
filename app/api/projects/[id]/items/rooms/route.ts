import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { BulkAssignRoomsInput } from "@/types";

/**
 * GET /api/projects/[id]/items/rooms
 * Every room allocation in the project — { item_id, room_id, room_name,
 * quantity } — for the spec register's room grouping and per-item editor.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: rooms } = await supabase
    .from("rooms")
    .select("id,name")
    .eq("project_id", projectId)
    .is("deleted_at", null);
  const roomIds = (rooms ?? []).map((r) => r.id);
  const roomName = new Map((rooms ?? []).map((r) => [r.id, r.name as string]));

  const { data: allocations } = roomIds.length
    ? await supabase.from("item_rooms").select("item_id,room_id,quantity").in("room_id", roomIds)
    : { data: [] as { item_id: string; room_id: string; quantity: number }[] };

  return NextResponse.json({
    allocations: (allocations ?? []).map((a) => ({
      ...a,
      room_name: roomName.get(a.room_id) ?? "",
    })),
  });
}

/**
 * DELETE /api/projects/[id]/items/rooms — remove one allocation.
 * body: { item_id, room_id }.
 */
export async function DELETE(
  request: NextRequest,
  { params: _params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { item_id?: string; room_id?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.item_id || !body.room_id) {
    return NextResponse.json({ error: "item_id and room_id are required" }, { status: 400 });
  }

  const { error } = await supabase
    .from("item_rooms")
    .delete()
    .eq("item_id", body.item_id)
    .eq("room_id", body.room_id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

/**
 * POST /api/projects/[id]/items/rooms
 * body: BulkAssignRoomsInput — { item_ids, room_ids, quantity, mode }.
 *
 * Bulk-assigns the selected items to the selected room(s), each allocation
 * carrying `quantity`. Upserts on (item_id, room_id) so re-assigning an
 * existing pair updates its quantity rather than duplicating. `mode:
 * "replace"` first clears every room allocation for the selected items
 * (their room set becomes exactly `room_ids`); "add" leaves untouched
 * rooms in place. Both item_ids and room_ids are validated to belong to
 * this project before any write (defence against forged cross-project ids).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: BulkAssignRoomsInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const itemIds = Array.isArray(body?.item_ids) ? body.item_ids : [];
  const roomIds = Array.isArray(body?.room_ids) ? body.room_ids : [];
  const quantity = Number(body?.quantity);
  const mode = body?.mode === "replace" ? "replace" : "add";

  if (itemIds.length === 0) return NextResponse.json({ error: "item_ids is required" }, { status: 400 });
  if (roomIds.length === 0) return NextResponse.json({ error: "room_ids is required" }, { status: 400 });
  if (!Number.isFinite(quantity) || quantity < 0) {
    return NextResponse.json({ error: "quantity must be a non-negative number" }, { status: 400 });
  }

  // Validate ownership: only item/room ids that belong to this project.
  const [{ data: validItems }, { data: validRooms }] = await Promise.all([
    supabase.from("items").select("id").eq("project_id", projectId).is("deleted_at", null).in("id", itemIds),
    supabase.from("rooms").select("id").eq("project_id", projectId).is("deleted_at", null).in("id", roomIds),
  ]);
  const okItemIds = (validItems ?? []).map((i) => i.id);
  const okRoomIds = (validRooms ?? []).map((r) => r.id);
  if (okItemIds.length === 0 || okRoomIds.length === 0) {
    return NextResponse.json({ error: "No valid items or rooms for this project" }, { status: 400 });
  }

  if (mode === "replace") {
    const { error: delError } = await supabase.from("item_rooms").delete().in("item_id", okItemIds);
    if (delError) return NextResponse.json({ error: delError.message }, { status: 500 });
  }

  const rows = okItemIds.flatMap((item_id) =>
    okRoomIds.map((room_id) => ({ item_id, room_id, quantity }))
  );

  const { data: upserted, error } = await supabase
    .from("item_rooms")
    .upsert(rows, { onConflict: "item_id,room_id" })
    .select("id");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    assigned: upserted?.length ?? 0,
    items: okItemIds.length,
    rooms: okRoomIds.length,
  });
}
