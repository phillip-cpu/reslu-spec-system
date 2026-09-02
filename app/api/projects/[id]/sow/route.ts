import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { seedSowSections, SOW_LEAD_SECTION, SOW_TRAILING_SECTIONS } from "@/lib/sow";
import type { CreateSowInput, SowDocument, SowSection } from "@/types";

/**
 * GET /api/projects/[id]/sow
 * Lists every non-deleted SOW revision for a project, newest first (by
 * created_at) — powers the revision picker in the SOW builder UI.
 * Team access (not admin-gated — a SOW isn't financial data, per
 * BUILD-SPEC.md "Scope of Works builder").
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: sow_documents, error } = await supabase
    .from("sow_documents")
    .select("*")
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ sow_documents: sow_documents as SowDocument[] });
}

/**
 * POST /api/projects/[id]/sow
 * Creates a new draft SOW for the project — this is ONLY how a
 * project's first revision (T1) gets created; subsequent revisions are
 * cloned via POST /api/projects/[id]/sow/[sowId]/new-revision, not this
 * route (which would happily create a second, unrelated T1-labelled
 * SOW with no lineage to the first — the UI only offers this route from
 * the empty state). Seeds the standard section structure per
 * BUILD-SPEC.md "Scope of Works builder": General/Preliminaries, then
 * one section per room in the project's FF&E room register (falling
 * back to legacy item locations, then the standard fallback rooms),
 * then Exclusions, Assumptions — see lib/sow.ts seedSowSections().
 *
 * Team access (not admin-gated). Aria-relevant: this is how Aria drafts
 * a SOW from project docs per BUILD-SPEC.md's Aria integration note.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: project } = await supabase
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .single();
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const body: CreateSowInput = await request.json().catch(() => ({}));
  const revisionLabel = body.revision_label?.trim() || "T1";

  // The current FF&E room register is authoritative for room-by-room SOW
  // structure. Keep legacy item.location values only as a fallback for older
  // projects that have not yet populated the rooms table.
  const { data: roomRows, error: roomRowsError } = await supabase
    .from("rooms")
    .select("id, name, sort")
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .order("sort", { ascending: true });
  if (roomRowsError) {
    return NextResponse.json({ error: roomRowsError.message }, { status: 500 });
  }

  const { data: itemRows, error: itemRowsError } = await supabase
    .from("items")
    .select("location")
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .not("location", "is", null);
  if (itemRowsError) {
    return NextResponse.json({ error: itemRowsError.message }, { status: 500 });
  }
  const legacyLocations = [
    ...new Set(
      (itemRows ?? [])
        .map((r) => (r as { location: string | null }).location?.trim())
        .filter((v): v is string => !!v)
    ),
  ].sort((a, b) => a.localeCompare(b));
  const currentRooms = (roomRows ?? [])
    .map((r) => ({
      id: (r as { id: string }).id,
      name: (r as { name: string | null }).name?.trim() ?? "",
    }))
    .filter((room) => room.name.length > 0);

  const { data: sow, error: sowError } = await supabase
    .from("sow_documents")
    .insert({
      project_id: projectId,
      revision_label: revisionLabel,
      status: "draft",
      created_by: user.id,
    })
    .select()
    .single();

  if (sowError) {
    const status = sowError.code === "23505" ? 409 : 500;
    const message =
      sowError.code === "23505"
        ? `A SOW revision "${revisionLabel}" already exists for this project.`
        : sowError.message;
    return NextResponse.json({ error: message }, { status });
  }

  const sectionSeeds = currentRooms.length > 0
    ? [
        { heading: SOW_LEAD_SECTION, source_room_id: null },
        ...currentRooms.map((room) => ({ heading: room.name, source_room_id: room.id })),
        ...SOW_TRAILING_SECTIONS.map((heading) => ({ heading, source_room_id: null })),
      ]
    : seedSowSections(legacyLocations).map((heading) => ({ heading, source_room_id: null }));
  const { data: sections, error: sectionsError } = await supabase
    .from("sow_sections")
    .insert(
      sectionSeeds.map((section, i) => ({
        sow_id: sow.id,
        heading: section.heading,
        sort: i + 1,
        source_room_id: section.source_room_id,
      }))
    )
    .select();

  if (sectionsError) {
    // Best-effort cleanup — the SOW row without any sections is not a
    // useful half-state to leave behind.
    await supabase.from("sow_documents").delete().eq("id", sow.id);
    return NextResponse.json({ error: sectionsError.message }, { status: 500 });
  }

  return NextResponse.json(
    {
      sow: sow as SowDocument,
      sections: ((sections ?? []) as SowSection[]).map((s) => ({ ...s, lines: [] })),
    },
    { status: 201 }
  );
}
