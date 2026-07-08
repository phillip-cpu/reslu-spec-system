import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

/**
 * POST /api/aria-queue/claim
 *
 * RESLU Second Brain, Step 2 (docs/RESLU-second-brain-build-brief.md).
 * The get_aria_queue MCP tool's thin-fetch target — atomically claims
 * up to `limit` pending (or abandoned — picked_up more than 15 minutes
 * ago) rows, oldest first, via claim_aria_queue_items() (migration
 * 034), the one place the FOR UPDATE SKIP LOCKED claim logic lives.
 *
 * Team-authenticated only (not admin-gated) — same tier as this
 * codebase's other MCP-polled attention feeds (GET /api/leads/attention,
 * GET /api/board-tasks/attention): queue events are operational, not
 * financial/procurement-sensitive.
 *
 * Response is deliberately trimmed to what the brief's own MCP tool
 * signature promises (`{ id, kind, payload, created_at }` per row) —
 * picked_up_at/attempts/dedupe_key/source/error are internal
 * bookkeeping Aria doesn't need to see on every poll.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { limit?: number } = {};
  try {
    body = await request.json();
  } catch {
    // Empty body is valid — limit defaults below.
  }

  const limit = Math.min(Math.max(1, Math.trunc(body.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);

  const { data, error } = await supabase.rpc("claim_aria_queue_items", { p_limit: limit });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const items = (data ?? []).map((row: { id: string; kind: string; payload: unknown; created_at: string }) => ({
    id: row.id,
    kind: row.kind,
    payload: row.payload,
    created_at: row.created_at,
  }));

  return NextResponse.json({ items });
}
