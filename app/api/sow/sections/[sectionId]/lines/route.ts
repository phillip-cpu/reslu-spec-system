import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { CreateSowLineInput, SowDocument, SowLineKind } from "@/types";

const VALID_KIND = new Set<SowLineKind>(["inclusion", "exclusion", "note"]);

/**
 * POST /api/sow/sections/[sectionId]/lines
 * Adds a line to a section — same single-save draft-row pattern as
 * components/estimate's DraftLineRow (BUILD-SPEC.md "Scope of Works
 * builder": "reuse those interaction patterns exactly"). Blocked once
 * the parent SOW is issued. Team access.
 */
export async function POST(
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

  const { data: section } = await supabase
    .from("sow_sections")
    .select("id, sow_id, sow_documents(status)")
    .eq("id", sectionId)
    .single();
  if (!section) {
    return NextResponse.json({ error: "Section not found" }, { status: 404 });
  }
  const parentStatus = (
    section as unknown as { sow_documents: Pick<SowDocument, "status"> | null }
  ).sow_documents?.status;
  if (parentStatus === "issued") {
    return NextResponse.json(
      { error: "This SOW has been issued and is immutable — use 'New revision' to edit it." },
      { status: 409 }
    );
  }

  let body: CreateSowLineInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body?.text?.trim()) {
    return NextResponse.json({ error: "text is required" }, { status: 400 });
  }
  if (body.kind && !VALID_KIND.has(body.kind)) {
    return NextResponse.json(
      { error: "kind must be one of inclusion, exclusion, note" },
      { status: 400 }
    );
  }

  const { data: existing } = await supabase
    .from("sow_lines")
    .select("sort")
    .eq("section_id", sectionId)
    .order("sort", { ascending: false })
    .limit(1);
  const nextSort = (existing?.[0]?.sort ?? 0) + 1;

  const { data: line, error } = await supabase
    .from("sow_lines")
    .insert({
      section_id: sectionId,
      text: body.text.trim(),
      kind: body.kind ?? "inclusion",
      sort: nextSort,
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ line }, { status: 201 });
}
