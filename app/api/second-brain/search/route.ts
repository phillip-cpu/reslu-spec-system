import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { embedTexts } from "@/lib/second-brain/embeddings";
import { ContentEntityType } from "@/lib/second-brain/content-for";
import { getUserRole } from "@/lib/auth";

export const runtime = "nodejs";

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 30;
const SNIPPET_LENGTH = 140;

/**
 * POST /api/second-brain/search
 *
 * RESLU Second Brain, Step 6 (docs/RESLU-second-brain-build-brief.md).
 * The `search` MCP tool's thin-fetch target — embeds the query inline
 * (same text-embedding-3-small model as the Step 5 indexer, non-
 * negotiable per the brief) then calls hybrid_search() (migration
 * 036) for the actual reciprocal-rank-fusion ranking.
 *
 * Team-authenticated general search. Stuart-owned finance memory is
 * excluded for non-admin accounts here and by database RLS.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const userInfo = await getUserRole(supabase);
  if (!userInfo) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { query?: string; entity_type?: string; limit?: number; response_format?: "concise" | "detailed" };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const query = body.query?.trim();
  if (!query) {
    return NextResponse.json({ error: "query is required" }, { status: 400 });
  }

  const limit = Math.min(Math.max(1, Math.trunc(body.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
  const responseFormat = body.response_format === "detailed" ? "detailed" : "concise";

  const [queryEmbedding] = await embedTexts([query]);

  const { data, error } = await supabase.rpc("hybrid_search", {
    query_text: query,
    query_embedding: `[${queryEmbedding.join(",")}]`,
    match_count: limit,
    filter_type: body.entity_type ?? null,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  let visibleRows = data as { id: string; entity_type: ContentEntityType; entity_id: string; title: string; content: string; score: number }[];
  if (userInfo.role !== "admin") {
    const memoryIds = visibleRows.filter((row) => row.entity_type === "memory").map((row) => row.entity_id);
    if (memoryIds.length > 0) {
      // Use the server-only client only to classify IDs already returned by
      // search. This remains a defence-in-depth filter even before/without
      // the matching workspace_index RLS migration; no restricted content is
      // returned from this lookup.
      const { data: stuartNotes, error: visibilityError } = await createServiceRoleClient()
        .from("brain_notes")
        .select("id")
        .in("id", memoryIds)
        .eq("source", "stuart");
      if (visibilityError) return NextResponse.json({ error: visibilityError.message }, { status: 500 });
      const restrictedIds = new Set((stuartNotes ?? []).map((note) => note.id));
      visibleRows = visibleRows.filter((row) => row.entity_type !== "memory" || !restrictedIds.has(row.entity_id));
    }
  }

  const results = visibleRows.map((row) =>
    responseFormat === "detailed"
      ? row
      : {
          id: row.id,
          entity_type: row.entity_type,
          entity_id: row.entity_id,
          title: row.title,
          snippet: row.content.length > SNIPPET_LENGTH ? `${row.content.slice(0, SNIPPET_LENGTH - 1)}…` : row.content,
          score: row.score,
        }
  );

  return NextResponse.json({ results });
}
