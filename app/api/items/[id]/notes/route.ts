import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { ItemNote } from "@/types";

/** GET /api/items/[id]/notes — attributed, timestamped notes. */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: notes, error } = await supabase
    .from("item_notes")
    .select("*")
    .eq("item_id", id)
    .order("created_at", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ notes: (notes ?? []) as ItemNote[] });
}

/** POST /api/items/[id]/notes — body { text }. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) {
    return NextResponse.json({ error: "Note text is required" }, { status: 400 });
  }

  // Denormalise the author name for display (item_notes.author_name).
  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name")
    .eq("id", user.id)
    .single();
  const author_name = profile?.full_name || user.email || "Team member";

  const { data: note, error } = await supabase
    .from("item_notes")
    .insert({ item_id: id, author_id: user.id, author_name, text })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ note: note as ItemNote }, { status: 201 });
}
