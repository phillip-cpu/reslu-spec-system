import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { PatchSowSectionInput, SowDocument } from "@/types";

/**
 * Looks up a section's parent SOW so every route here can enforce the
 * "issued SOWs are immutable" rule (BUILD-SPEC.md "Scope of Works
 * builder") without duplicating the join in each handler.
 */
async function loadParentSow(
  supabase: Awaited<ReturnType<typeof createClient>>,
  sectionId: string
) {
  const { data: section } = await supabase
    .from("sow_sections")
    .select("id, sow_id, sow_documents(status)")
    .eq("id", sectionId)
    .single();
  if (!section) return null;
  const sow = (section as unknown as { sow_documents: Pick<SowDocument, "status"> | null })
    .sow_documents;
  return { section, status: sow?.status ?? null };
}

/**
 * PATCH /api/sow/sections/[sectionId]
 * body: { heading?, sort? }. Blocked once the parent SOW is issued.
 * Team access.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ sectionId: string }> }
) {
  const { sectionId } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parent = await loadParentSow(supabase, sectionId);
  if (!parent) {
    return NextResponse.json({ error: "Section not found" }, { status: 404 });
  }
  if (parent.status === "issued") {
    return NextResponse.json(
      { error: "This SOW has been issued and is immutable — use 'New revision' to edit it." },
      { status: 409 }
    );
  }

  let body: PatchSowSectionInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const update: Record<string, unknown> = {};
  if (typeof body.heading === "string" && body.heading.trim()) update.heading = body.heading.trim();
  if (body.sort !== undefined && Number.isFinite(Number(body.sort))) update.sort = Number(body.sort);
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const { data: section, error } = await supabase
    .from("sow_sections")
    .update(update)
    .eq("id", sectionId)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ section });
}

/**
 * DELETE /api/sow/sections/[sectionId]
 * Hard-deletes the section — sow_lines cascade. Blocked once the
 * parent SOW is issued. Team access.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ sectionId: string }> }
) {
  const { sectionId } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parent = await loadParentSow(supabase, sectionId);
  if (!parent) {
    return NextResponse.json({ error: "Section not found" }, { status: 404 });
  }
  if (parent.status === "issued") {
    return NextResponse.json(
      { error: "This SOW has been issued and is immutable — use 'New revision' to edit it." },
      { status: 409 }
    );
  }

  const { error } = await supabase.from("sow_sections").delete().eq("id", sectionId);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
