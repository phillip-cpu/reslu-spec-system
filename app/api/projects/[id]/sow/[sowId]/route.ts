import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { SowDocument, SowSectionWithLines } from "@/types";

/**
 * GET /api/projects/[id]/sow/[sowId]
 * Returns one SOW revision with its sections and lines nested, sorted.
 * Team access (not admin-gated).
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; sowId: string }> }
) {
  const { id: projectId, sowId } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: sow, error: sowError } = await supabase
    .from("sow_documents")
    .select("*")
    .eq("id", sowId)
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .single();
  if (sowError || !sow) {
    return NextResponse.json({ error: "SOW not found" }, { status: 404 });
  }

  const { data: sections, error: sectionsError } = await supabase
    .from("sow_sections")
    .select("*, sow_lines(*)")
    .eq("sow_id", sowId)
    .order("sort", { ascending: true });
  if (sectionsError) {
    return NextResponse.json({ error: sectionsError.message }, { status: 500 });
  }

  const sectionsWithLines: SowSectionWithLines[] = (sections ?? []).map((section) => {
    const lines = (
      (section as unknown as { sow_lines: SowSectionWithLines["lines"] }).sow_lines ?? []
    ).sort((a, b) => a.sort - b.sort);
    const { sow_lines: _omit, ...rest } = section as unknown as Record<string, unknown>;
    void _omit;
    return { ...(rest as unknown as SowSectionWithLines), lines };
  });

  return NextResponse.json({ sow: sow as SowDocument, sections: sectionsWithLines });
}

/**
 * DELETE /api/projects/[id]/sow/[sowId]
 * Soft-deletes a SOW revision (deleted_at) — e.g. discarding an
 * abandoned draft. An issued SOW can still be deleted here (no status
 * guard) since "issued" only protects it from in-place editing, not
 * from being retired from the revision list; the PDF route still works
 * against a soft-deleted row's id if a link to it exists elsewhere, but
 * it drops out of the GET list/picker. Team access.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; sowId: string }> }
) {
  const { id: projectId, sowId } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { error } = await supabase
    .from("sow_documents")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", sowId)
    .eq("project_id", projectId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
