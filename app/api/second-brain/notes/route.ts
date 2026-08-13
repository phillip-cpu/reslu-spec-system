import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { normalizeBrainNoteSource } from "@/lib/second-brain/brain-notes";

export const runtime = "nodejs";

const MAX_TITLE = 160;
const MAX_BODY = 10_000;
const MAX_TAGS = 20;
const MARCO_EMAIL = (process.env.MARCO_EMAIL ?? "marco@reslu.com.au").trim().toLowerCase();

/** POST - add a source-attributed durable learning to Second Brain. */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const userInfo = await getUserRole(supabase);
  if (!userInfo) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: {
    title?: string;
    body?: string;
    tags?: string[];
    source?: string;
    source_ref?: string;
    confidence?: number;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const title = body.title?.trim().slice(0, MAX_TITLE);
  const noteBody = body.body?.trim().slice(0, MAX_BODY);
  if (!title || !noteBody) {
    return NextResponse.json({ error: "title and body are required" }, { status: 400 });
  }
  if (
    body.confidence !== undefined &&
    (!Number.isFinite(body.confidence) || body.confidence < 0 || body.confidence > 1)
  ) {
    return NextResponse.json({ error: "confidence must be between 0 and 1" }, { status: 400 });
  }

  const tags = [...new Set((body.tags ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean))]
    .slice(0, MAX_TAGS)
    .map((tag) => tag.slice(0, 60));
  const source = normalizeBrainNoteSource(body.source);
  const isMarcoAgent = userInfo.email === MARCO_EMAIL;
  if (isMarcoAgent && source !== "marco") {
    return NextResponse.json({ error: "Marco may only publish notes attributed to Marco" }, { status: 403 });
  }
  if (source === "stuart" && userInfo.role !== "admin") {
    return NextResponse.json({ error: "Stuart finance memory is restricted to administrators" }, { status: 403 });
  }
  const sourceRef = body.source_ref?.trim().slice(0, 500) || null;
  if (isMarcoAgent && !sourceRef?.startsWith("marco://workspace/")) {
    return NextResponse.json({ error: "Marco notes require a stable marco://workspace/... source_ref" }, { status: 400 });
  }
  const noteValues = {
    title,
    body: noteBody,
    tags,
    source,
    source_ref: sourceRef,
    confidence: body.confidence ?? null,
  };

  // Agent publications use a stable source_ref (for example
  // marco://workspace/memory/2026-08-09.md). Updating that publication
  // keeps one durable graph node instead of creating a duplicate every run.
  if (sourceRef) {
    let lookup = supabase
      .from("brain_notes")
      .select("id")
      .eq("source", source)
      .eq("source_ref", sourceRef);
    if (isMarcoAgent) lookup = lookup.eq("created_by", userInfo.userId);
    const { data: existing, error: lookupError } = await lookup
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (lookupError) return NextResponse.json({ error: lookupError.message }, { status: 500 });
    if (existing) {
      let update = supabase
        .from("brain_notes")
        .update(noteValues)
        .eq("id", existing.id);
      if (isMarcoAgent) update = update.eq("created_by", userInfo.userId);
      const { data: note, error } = await update
        .select("id,title,tags,source,source_ref,confidence,created_at,updated_at")
        .single();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ note, created: false });
    }
  }

  const { data: note, error } = await supabase
    .from("brain_notes")
    .insert({
      ...noteValues,
      created_by: userInfo.userId,
    })
    .select("id,title,tags,source,source_ref,confidence,created_at,updated_at")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ note, created: true }, { status: 201 });
}
