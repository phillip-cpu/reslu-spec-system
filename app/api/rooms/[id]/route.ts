import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * PATCH /api/rooms/[id] — rename or re-sort a room. body: { name?, sort? }.
 * DELETE /api/rooms/[id] — soft-delete a room (its item_rooms allocations
 * are removed by the ON DELETE CASCADE only on a hard delete, so here we
 * soft-delete the room and hard-delete its allocations so the per-room
 * counts/PDF stay correct while the room row itself is recoverable).
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { name?: string; sort?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const patch: Record<string, unknown> = {};
  if (typeof body.name === "string") {
    const name = body.name.trim();
    if (!name) return NextResponse.json({ error: "name cannot be blank" }, { status: 400 });
    patch.name = name;
  }
  if (typeof body.sort === "number") patch.sort = body.sort;
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const { data: room, error } = await supabase
    .from("rooms")
    .update(patch)
    .eq("id", id)
    .is("deleted_at", null)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ room });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  await supabase.from("item_rooms").delete().eq("room_id", id);
  const { error } = await supabase
    .from("rooms")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
