import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const VALID_STATUSES = new Set(["done", "failed"]);

/**
 * POST /api/aria-queue/[id]/resolve
 *
 * RESLU Second Brain, Step 2 (docs/RESLU-second-brain-build-brief.md).
 * The resolve_queue_item MCP tool's thin-fetch target. Sets
 * status ('done' | 'failed') and resolved_at — rows are never
 * deleted, a resolved row is this table's own audit trail (see
 * migration 033's table comment).
 *
 * `note`, when supplied, is stored in the existing `error` column —
 * the brief's Step 1 schema has no separate free-text annotation
 * column, and adding one is out of this step's scope (Step 2 is MCP
 * tools only, no new migration). The column name reads oddly for a
 * 'done' resolution's note, but it is the only place available; a
 * future step can rename/add a column if this proves confusing in
 * practice.
 *
 * Team-authenticated only (not admin-gated) — same tier as claim/
 * route.ts above.
 */
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

  let body: { status?: string; note?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.status || !VALID_STATUSES.has(body.status)) {
    return NextResponse.json({ error: "status must be 'done' or 'failed'" }, { status: 400 });
  }

  const { data: updated, error } = await supabase
    .from("aria_queue")
    .update({
      status: body.status,
      resolved_at: new Date().toISOString(),
      error: body.note?.trim() || null,
    })
    .eq("id", id)
    .select("id,status,resolved_at")
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!updated) {
    return NextResponse.json({ error: "Queue item not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
