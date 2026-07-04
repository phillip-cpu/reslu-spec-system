import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { PatchSowLineInput, SowDocument, SowLineKind } from "@/types";

const VALID_KIND = new Set<SowLineKind>(["inclusion", "exclusion", "note"]);

async function loadParentStatus(
  supabase: Awaited<ReturnType<typeof createClient>>,
  lineId: string
) {
  const { data: line } = await supabase
    .from("sow_lines")
    .select("id, section_id, sow_sections(sow_id, sow_documents(status))")
    .eq("id", lineId)
    .single();
  if (!line) return null;
  const section = (
    line as unknown as {
      sow_sections: { sow_documents: Pick<SowDocument, "status"> | null } | null;
    }
  ).sow_sections;
  return section?.sow_documents?.status ?? null;
}

/**
 * PATCH /api/sow/lines/[lineId]
 * body: { text?, kind?, sort? } — single-save pattern, same as an
 * estimate line row's onPatch. Blocked once the parent SOW is issued.
 * Team access.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ lineId: string }> }
) {
  const { lineId } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const status = await loadParentStatus(supabase, lineId);
  if (status === null) {
    return NextResponse.json({ error: "Line not found" }, { status: 404 });
  }
  if (status === "issued") {
    return NextResponse.json(
      { error: "This SOW has been issued and is immutable — use 'New revision' to edit it." },
      { status: 409 }
    );
  }

  let body: PatchSowLineInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (body.kind !== undefined && !VALID_KIND.has(body.kind)) {
    return NextResponse.json(
      { error: "kind must be one of inclusion, exclusion, note" },
      { status: 400 }
    );
  }

  const update: Record<string, unknown> = {};
  if (typeof body.text === "string") {
    if (!body.text.trim()) {
      return NextResponse.json({ error: "text cannot be empty" }, { status: 400 });
    }
    update.text = body.text.trim();
  }
  if (body.kind !== undefined) update.kind = body.kind;
  if (body.sort !== undefined && Number.isFinite(Number(body.sort))) update.sort = Number(body.sort);

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const { data: line, error } = await supabase
    .from("sow_lines")
    .update(update)
    .eq("id", lineId)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ line });
}

/**
 * DELETE /api/sow/lines/[lineId]
 * Hard-deletes the line. Blocked once the parent SOW is issued. Team access.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ lineId: string }> }
) {
  const { lineId } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const status = await loadParentStatus(supabase, lineId);
  if (status === null) {
    return NextResponse.json({ error: "Line not found" }, { status: 404 });
  }
  if (status === "issued") {
    return NextResponse.json(
      { error: "This SOW has been issued and is immutable — use 'New revision' to edit it." },
      { status: 409 }
    );
  }

  const { error } = await supabase.from("sow_lines").delete().eq("id", lineId);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
