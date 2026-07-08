import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * POST /api/second-brain/matches/[id]/correct
 *
 * RESLU Second Brain, Step 10 (docs/RESLU-second-brain-build-brief.md).
 * Human correction of a review/no_match email_entity_matches row —
 * the mechanism the brief's own acceptance criterion depends on
 * ("after correcting it once, the same mention auto-links on
 * re-run"). Updates the match row AND inserts an entity_aliases row
 * so the SAME mention text auto-links via the matching ladder's rung
 * 2 next time, without needing this correction repeated.
 *
 * Team-authenticated only, not admin-gated — matching corrections are
 * operational, not financial data on their own (mirrors the tier of
 * aria-queue's routes).
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { entity_id?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.entity_id) {
    return NextResponse.json({ error: "entity_id is required" }, { status: 400 });
  }

  const { data: match, error: matchError } = await supabase
    .from("email_entity_matches")
    .select("id,source_text,entity_type")
    .eq("id", id)
    .maybeSingle();
  if (matchError) return NextResponse.json({ error: matchError.message }, { status: 500 });
  if (!match) return NextResponse.json({ error: "Match not found" }, { status: 404 });

  const { error: updateError } = await supabase
    .from("email_entity_matches")
    .update({
      entity_id: body.entity_id,
      status: "matched",
      confidence: 1.0,
      method: "human_correction",
      resolved_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

  const { error: aliasError } = await supabase.from("entity_aliases").upsert(
    {
      entity_type: match.entity_type,
      entity_id: body.entity_id,
      alias: match.source_text.trim().toLowerCase(),
      source: "human_correction",
    },
    { onConflict: "entity_type,alias" }
  );
  if (aliasError) return NextResponse.json({ error: aliasError.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
