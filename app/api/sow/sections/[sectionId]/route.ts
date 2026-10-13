import { normalizeSowHeadingOverride } from "@/lib/sow-display-headings";
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
    .select("id, sow_id, source_room_id, updated_at, trade_heading_overrides, sow_documents(status)")
    .eq("id", sectionId)
    .single();
  if (!section) return null;
  const sow = (section as unknown as { sow_documents: Pick<SowDocument, "status"> | null })
    .sow_documents;
  return {
    section,
    status: sow?.status ?? null,
    linkedRoom: Boolean(section.source_room_id),
  };
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
  if (parent.linkedRoom && typeof body.heading === "string") {
    return NextResponse.json(
      { error: "Linked room headings are managed from the FF&E room register." },
      { status: 409 }
    );
  }

  const update: Record<string, unknown> = {};
  if (typeof body.heading === "string" && body.heading.trim()) update.heading = body.heading.trim();
  if (body.sort !== undefined && Number.isFinite(Number(body.sort))) update.sort = Number(body.sort);
  if (body.trade_heading_override !== undefined) {
    if (body.expected_updated_at !== parent.section.updated_at) return NextResponse.json({ error: "Section changed. Reload before editing the display heading." }, { status: 409 });
    let override;
    try { override = normalizeSowHeadingOverride(body.trade_heading_override); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
    const { data: lines, error: tradeError } = await supabase.from("sow_lines").select("id").eq("section_id", sectionId).eq("trade", override.trade).limit(1);
    if (tradeError || !lines?.length) return NextResponse.json({ error: "Trade is not present in this section." }, { status: 400 });
    const headings = { ...(parent.section.trade_heading_overrides ?? {}) };
    if (override.heading === null) delete headings[override.trade]; else headings[override.trade] = override.heading;
    update.trade_heading_overrides = headings;
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const { data: section, error } = await supabase
    .from("sow_sections")
    .update(update)
    .eq("id", sectionId)
    .eq("updated_at", parent.section.updated_at)
    .select()
    .maybeSingle();

  if (!error && !section) return NextResponse.json({ error: "Section changed. Reload before saving." }, { status: 409 });
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
  if (parent.linkedRoom) {
    return NextResponse.json(
      { error: "Linked room sections are managed from the FF&E room register." },
      { status: 409 }
    );
  }

  const { error } = await supabase.from("sow_sections").delete().eq("id", sectionId);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
