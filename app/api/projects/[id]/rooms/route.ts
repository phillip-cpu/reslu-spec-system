import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { CreateRoomInput, RoomWithCount } from "@/types";

const SORT_STEP = 1000;

/**
 * GET /api/projects/[id]/rooms
 * Team-visible. Lists the project's rooms (sorted), each annotated with
 * how many items are assigned to it (one batched count over item_rooms,
 * not N+1). Used by the spec-register bulk-assign UI and the per-room PDF.
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
    .select("*")
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .order("sort", { ascending: true });

  const roomIds = (rooms ?? []).map((r) => r.id);
  const { data: allocations } = roomIds.length
    ? await supabase.from("item_rooms").select("room_id").in("room_id", roomIds)
    : { data: [] as { room_id: string }[] };

  const countByRoom = new Map<string, number>();
  for (const a of allocations ?? []) {
    countByRoom.set(a.room_id, (countByRoom.get(a.room_id) ?? 0) + 1);
  }

  const result: RoomWithCount[] = (rooms ?? []).map((r) => ({
    ...r,
    item_count: countByRoom.get(r.id) ?? 0,
  }));

  return NextResponse.json({ rooms: result });
}

/**
 * POST /api/projects/[id]/rooms
 * body: CreateRoomInput — { name }. Creates a room at the bottom of the
 * list (sort = max + SORT_STEP). Names are trimmed; a blank name is 400.
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

  let body: CreateRoomInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const name = body?.name?.trim();
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });

  const { data: project } = await supabase
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .single();
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  const { data: maxRow } = await supabase
    .from("rooms")
    .select("sort")
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .order("sort", { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextSort = (maxRow?.sort ?? -SORT_STEP) + SORT_STEP;

  const { data: room, error } = await supabase
    .from("rooms")
    .insert({ project_id: projectId, name, sort: nextSort })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ room }, { status: 201 });
}
