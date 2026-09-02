import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { buildSowLineCopies } from "@/lib/sow-copy-lines";
import type { SowLineWithTrade, CopySowLinesInput } from "@/types/sow-trade-tags";

const MAX_SOURCE_LINES = 100;
const MAX_TARGET_ROOMS = 50;
const MAX_COPIES = 500;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function uniqueIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || !UUID_PATTERN.test(id))) {
    return null;
  }
  return [...new Set(value)];
}

/**
 * POST /api/projects/[id]/sow/[sowId]/copy-lines
 * Copies selected SOW lines into one or more linked room sections.
 * Text, kind, and trade are preserved and each room receives the
 * copies at the end of its existing line order. The source and every
 * destination must belong to the same editable SOW revision.
 */
export async function POST(
  request: NextRequest,
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

  let body: CopySowLinesInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const lineIds = uniqueIds(body?.line_ids);
  const targetSectionIds = uniqueIds(body?.target_section_ids);
  if (!lineIds?.length) {
    return NextResponse.json({ error: "Select at least one line to copy." }, { status: 400 });
  }
  if (!targetSectionIds?.length) {
    return NextResponse.json({ error: "Select at least one destination room." }, { status: 400 });
  }
  if (lineIds.length > MAX_SOURCE_LINES || targetSectionIds.length > MAX_TARGET_ROOMS) {
    return NextResponse.json({ error: "Too many lines or destination rooms selected." }, { status: 400 });
  }
  if (lineIds.length * targetSectionIds.length > MAX_COPIES) {
    return NextResponse.json({ error: `A single copy action is limited to ${MAX_COPIES} new lines.` }, { status: 400 });
  }

  const { data: sow } = await supabase
    .from("sow_documents")
    .select("id,status")
    .eq("id", sowId)
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .single();
  if (!sow) {
    return NextResponse.json({ error: "SOW not found" }, { status: 404 });
  }
  if (sow.status === "issued") {
    return NextResponse.json(
      { error: "This SOW has been issued and is immutable — use 'New revision' to edit it." },
      { status: 409 }
    );
  }

  const { data: sections, error: sectionsError } = await supabase
    .from("sow_sections")
    .select("id,sort,source_room_id")
    .eq("sow_id", sowId);
  if (sectionsError) {
    return NextResponse.json({ error: sectionsError.message }, { status: 500 });
  }
  const sectionById = new Map((sections ?? []).map((section) => [section.id, section]));
  const invalidTarget = targetSectionIds.find((id) => !sectionById.get(id)?.source_room_id);
  if (invalidTarget) {
    return NextResponse.json({ error: "Every destination must be a room in this SOW." }, { status: 400 });
  }

  const { data: sourceLines, error: sourceError } = await supabase
    .from("sow_lines")
    .select("*")
    .in("id", lineIds);
  if (sourceError) {
    return NextResponse.json({ error: sourceError.message }, { status: 500 });
  }
  const typedSourceLines = (sourceLines ?? []) as SowLineWithTrade[];
  if (
    typedSourceLines.length !== lineIds.length ||
    typedSourceLines.some((line) => !sectionById.has(line.section_id))
  ) {
    return NextResponse.json({ error: "One or more selected lines are not in this SOW." }, { status: 400 });
  }

  const sourceSectionIds = new Set(typedSourceLines.map((line) => line.section_id));
  if (targetSectionIds.some((id) => sourceSectionIds.has(id))) {
    return NextResponse.json({ error: "Choose other rooms, not a selected line's source room." }, { status: 400 });
  }

  typedSourceLines.sort((left, right) => {
    const sectionDifference =
      (sectionById.get(left.section_id)?.sort ?? 0) -
      (sectionById.get(right.section_id)?.sort ?? 0);
    return sectionDifference || left.sort - right.sort;
  });

  const { data: existingLines, error: existingError } = await supabase
    .from("sow_lines")
    .select("section_id,sort")
    .in("section_id", targetSectionIds);
  if (existingError) {
    return NextResponse.json({ error: existingError.message }, { status: 500 });
  }
  const maxSortBySection = new Map<string, number>();
  for (const line of existingLines ?? []) {
    maxSortBySection.set(
      line.section_id,
      Math.max(maxSortBySection.get(line.section_id) ?? 0, line.sort)
    );
  }

  const copies = buildSowLineCopies(typedSourceLines, targetSectionIds, maxSortBySection);

  // One multi-row INSERT keeps this copy action atomic: either every
  // requested room receives its copies or none of them do. `.select()`
  // returns the inserted rows for an immediate client-side merge.
  const { data: insertedLines, error: insertError } = await supabase
    .from("sow_lines")
    .insert(copies)
    .select();
  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  return NextResponse.json(
    {
      lines: (insertedLines ?? []) as SowLineWithTrade[],
      copied_count: insertedLines?.length ?? 0,
      target_room_count: targetSectionIds.length,
    },
    { status: 201 }
  );
}
