import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { PatchUserNoteInput } from "@/types/phase-12a-b";

const EDITABLE_FIELDS = new Set(["text", "done", "sort"]);

/**
 * PATCH /api/my-work/notes/[id]
 * body: PatchUserNoteInput (partial) — tick done, edit text inline, or
 * reorder (sort). Response: { note }. Scoped to the signed-in user's
 * own notes ONLY — the `.eq("user_id", user.id)` filter on both the
 * existence check and the update itself means a forged id belonging to
 * another user's note 404s rather than ever being readable/writable
 * here (this is the real enforcement point referenced by migration
 * 020's RLS doc comment on user_notes — see that migration for why
 * this lives in the API layer rather than a per-row RLS policy).
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
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: existing } = await supabase
    .from("user_notes")
    .select("id")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();
  if (!existing) {
    return NextResponse.json({ error: "Note not found" }, { status: 404 });
  }

  let body: PatchUserNoteInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const update: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(body)) {
    if (!EDITABLE_FIELDS.has(key)) continue;
    if (key === "text") {
      const trimmed = typeof raw === "string" ? raw.trim() : raw;
      if (!trimmed) {
        return NextResponse.json({ error: "text cannot be empty" }, { status: 400 });
      }
      update.text = trimmed;
    } else if (key === "sort") {
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        return NextResponse.json({ error: "sort must be a number" }, { status: 400 });
      }
      update.sort = n;
    } else {
      update[key] = raw;
    }
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const { data: note, error } = await supabase
    .from("user_notes")
    .update(update)
    .eq("id", id)
    .eq("user_id", user.id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ note });
}

/**
 * DELETE /api/my-work/notes/[id]
 * Hard delete — user_notes has no deleted_at column (a personal
 * scratchpad has no audit-trail requirement, unlike items/board_tasks/
 * client_events). Scoped to the signed-in user's own notes only.
 */
export async function DELETE(
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

  const { error } = await supabase.from("user_notes").delete().eq("id", id).eq("user_id", user.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
