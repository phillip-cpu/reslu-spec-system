import { NextRequest, NextResponse } from "next/server";
import { getUserRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

interface ReorderLinesBody {
  line_ids?: unknown;
}

/**
 * PATCH /api/estimate/sections/[sectionId]/lines/reorder
 *
 * Persists the complete order of a section's active estimate lines. The
 * complete-list contract prevents a stale browser from silently omitting a
 * line that was added elsewhere, and section scoping prevents moving lines
 * between estimate sections through this endpoint.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ sectionId: string }> }
) {
  const { sectionId } = await params;
  const supabase = await createClient();

  const info = await getUserRole(supabase);
  if (!info) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (info.role !== "admin") {
    return NextResponse.json(
      { error: "Only admins can access the Estimate module" },
      { status: 403 }
    );
  }

  let body: ReorderLinesBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (
    !Array.isArray(body.line_ids) ||
    body.line_ids.some((id) => typeof id !== "string" || id.length === 0)
  ) {
    return NextResponse.json({ error: "line_ids must be an array of line IDs" }, { status: 400 });
  }

  const lineIds = body.line_ids as string[];
  if (new Set(lineIds).size !== lineIds.length) {
    return NextResponse.json({ error: "line_ids cannot contain duplicates" }, { status: 400 });
  }

  const { data: section, error: sectionError } = await supabase
    .from("cost_sections")
    .select("id")
    .eq("id", sectionId)
    .single();
  if (sectionError || !section) {
    return NextResponse.json({ error: "Section not found" }, { status: 404 });
  }

  const { data: existing, error: existingError } = await supabase
    .from("cost_lines")
    .select("id, sort")
    .eq("section_id", sectionId)
    .is("deleted_at", null)
    .order("sort", { ascending: true });
  if (existingError) {
    return NextResponse.json({ error: existingError.message }, { status: 500 });
  }

  const existingIds = new Set((existing ?? []).map((line) => line.id));
  if (lineIds.length !== existingIds.size || lineIds.some((id) => !existingIds.has(id))) {
    return NextResponse.json(
      { error: "The estimate changed while you were reordering it. Refresh and try again." },
      { status: 409 }
    );
  }

  // No unique constraint exists on sort, so the rows can be updated safely
  // in parallel. Ten-point spacing keeps the stored values easy to inspect
  // and leaves room for future single-row insertion strategies.
  const updates = await Promise.all(
    lineIds.map((id, index) =>
      supabase
        .from("cost_lines")
        .update({ sort: (index + 1) * 10 })
        .eq("id", id)
        .eq("section_id", sectionId)
        .is("deleted_at", null)
    )
  );
  const failed = updates.find((result) => result.error);
  if (failed?.error) {
    // Best-effort rollback of any rows already updated by the parallel batch.
    await Promise.all(
      (existing ?? []).map((line) =>
        supabase
          .from("cost_lines")
          .update({ sort: line.sort })
          .eq("id", line.id)
          .eq("section_id", sectionId)
          .is("deleted_at", null)
      )
    );
    return NextResponse.json({ error: failed.error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
