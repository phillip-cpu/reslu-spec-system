import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const MAX_TITLE = 160;
const MAX_BODY = 10_000;
const MAX_TAGS = 20;

/** POST - add a source-attributed durable learning to Second Brain. */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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

  const { data: note, error } = await supabase
    .from("brain_notes")
    .insert({
      title,
      body: noteBody,
      tags,
      source: body.source?.trim().slice(0, 80) || "aria",
      source_ref: body.source_ref?.trim().slice(0, 500) || null,
      confidence: body.confidence ?? null,
      created_by: user.id,
    })
    .select("id,title,tags,source,source_ref,confidence,created_at")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ note }, { status: 201 });
}
