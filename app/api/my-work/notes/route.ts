import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { CreateUserNoteInput, UserNotesResponse } from "@/types/phase-12a-b";

/**
 * GET /api/my-work/notes
 * Personal notes panel (BUILD-SPEC.md §"Phase 12a — My Work": "Personal
 * notes section (user_notes table: user_id, text, done, ...)"). Always
 * scoped to the signed-in user's own rows — user_notes carries no
 * project/team visibility concept at all, it's a private scratchpad.
 * Not-done notes first (sort ascending), then done notes (also sort
 * ascending) — so ticking a note off moves it below the active list
 * without needing a second fetch/sort on the client.
 */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: notes, error } = await supabase
    .from("user_notes")
    .select("*")
    .eq("user_id", user.id)
    .order("done", { ascending: true })
    .order("sort", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const body: UserNotesResponse = { notes: notes ?? [] };
  return NextResponse.json(body);
}

/**
 * POST /api/my-work/notes
 * body: CreateUserNoteInput — { text }. Response: { note } (201). New
 * notes land at the top (sort = min(existing sort) - 1000, or 0 if this
 * is the user's first note) so a freshly-added note doesn't get lost
 * below a long list — the reverse of the board's "new cards land at
 * the bottom" convention, a deliberate difference since a personal
 * to-do list reads top-down as "most recently top-of-mind" rather than
 * a queue.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: CreateUserNoteInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.text?.trim()) {
    return NextResponse.json({ error: "text is required" }, { status: 400 });
  }

  const { data: minRow } = await supabase
    .from("user_notes")
    .select("sort")
    .eq("user_id", user.id)
    .order("sort", { ascending: true })
    .limit(1)
    .maybeSingle();

  const nextSort = (minRow?.sort ?? 1000) - 1000;

  const { data: note, error } = await supabase
    .from("user_notes")
    .insert({ user_id: user.id, text: body.text.trim(), sort: nextSort })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ note }, { status: 201 });
}
