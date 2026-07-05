import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { roomSectionHeadings } from "@/lib/sow";
import {
  SOW_TEMPLATE_LIBRARY,
  STANDARD_TEMPLATE_GROUPS,
  TRAILING_TEMPLATE_GROUPS,
  roomSectionTemplate,
} from "@/lib/sow-templates";
import type { SowDocument, SowSectionWithLines } from "@/types";
import type { ApplyTemplateInput, ApplyTemplateResponse } from "@/types/phase-12a-a";

/**
 * POST /api/projects/[id]/sow/[sowId]/from-template
 * "Start from template" — BUILD-SPEC.md "SOW completion + Aria plan
 * analysis": "'Start from template' action on new SOW populates
 * sections/lines from the library + one section per project room
 * (read rooms from the CURRENT rooms schema). Keep everything editable
 * via the existing builder."
 *
 * Appends sections (never replaces existing ones — safe to run on a
 * SOW that already has content from the plain POST /api/projects/[id]/sow
 * seed, e.g. to backfill General Notes/Exclusions onto an older SOW
 * that predates this feature). Only valid on a DRAFT SOW — an issued
 * revision is immutable, same rule the builder already enforces for
 * every other section/line mutation on this resource.
 *
 * body: ApplyTemplateInput — { groups?, include_rooms? }. Omitting
 * `groups` applies the full standard set (Project Overview, General
 * Notes ×3, then room sections, then Site Management & Handover +
 * Exclusions) in that fixed order; passing `groups` applies only the
 * named clause groups (still followed by room sections unless
 * include_rooms is explicitly false) — lets a team member top up just
 * "Exclusions" on an existing SOW without re-adding everything else.
 *
 * Team access (not admin-gated — a SOW isn't financial data, same as
 * every other SOW route).
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
  const typedSow = sow as SowDocument;
  if (typedSow.status !== "draft") {
    return NextResponse.json(
      { error: "Only a draft SOW can have template content applied — issued revisions are read-only." },
      { status: 400 }
    );
  }

  let body: ApplyTemplateInput = {};
  try {
    body = (await request.json()) ?? {};
  } catch {
    // No body / empty body is fine — defaults to the full standard set.
  }

  const requestedGroups = Array.isArray(body.groups) && body.groups.length > 0 ? body.groups : null;
  const includeRooms = body.include_rooms !== false;

  // Determine the ordered list of library groups to apply. When
  // `groups` isn't given, use the full standard set (lead groups),
  // room sections (if included), then trailing groups — matching the
  // canonical SOW shape from BUILD-SPEC.md "SOW structure": Project
  // Overview -> General Notes -> room sections -> Site Management &
  // Handover -> Exclusions.
  const leadGroups = requestedGroups
    ? requestedGroups.filter((g) => STANDARD_TEMPLATE_GROUPS.includes(g as (typeof STANDARD_TEMPLATE_GROUPS)[number]))
    : [...STANDARD_TEMPLATE_GROUPS];
  const trailingGroups = requestedGroups
    ? requestedGroups.filter((g) => TRAILING_TEMPLATE_GROUPS.includes(g as (typeof TRAILING_TEMPLATE_GROUPS)[number]))
    : [...TRAILING_TEMPLATE_GROUPS];
  // Any explicitly-requested group name not recognised at all (typo, or
  // a name from neither list) is silently ignored rather than erroring
  // — an unknown group is a no-op, not a failure, since the two arrays
  // above already cover 100% of SOW_TEMPLATE_LIBRARY's keys.
  void SOW_TEMPLATE_LIBRARY;

  let roomNames: string[] = [];
  if (includeRooms) {
    const { data: rooms } = await supabase
      .from("rooms")
      .select("name")
      .eq("project_id", projectId)
      .is("deleted_at", null)
      .order("sort", { ascending: true });
    roomNames = roomSectionHeadings((rooms ?? []).map((r) => r.name as string));
  }

  // Existing sections' max sort, so appended template sections land
  // after anything already there rather than colliding sort values.
  const { data: maxSortRow } = await supabase
    .from("sow_sections")
    .select("sort")
    .eq("sow_id", sowId)
    .order("sort", { ascending: false })
    .limit(1)
    .maybeSingle();
  let nextSort = (maxSortRow?.sort ?? 0) + 1;

  const templateSections = [
    ...leadGroups.map((g) => SOW_TEMPLATE_LIBRARY[g]).filter(Boolean),
    ...roomNames.map((name) => roomSectionTemplate(name)),
    ...trailingGroups.map((g) => SOW_TEMPLATE_LIBRARY[g]).filter(Boolean),
  ];

  if (templateSections.length === 0) {
    return NextResponse.json({ error: "No template content matched the requested groups" }, { status: 400 });
  }

  const createdSections: SowSectionWithLines[] = [];

  for (const template of templateSections) {
    const { data: section, error: sectionError } = await supabase
      .from("sow_sections")
      .insert({ sow_id: sowId, heading: template.heading, sort: nextSort })
      .select()
      .single();
    if (sectionError || !section) {
      return NextResponse.json(
        { error: sectionError?.message ?? "Could not create a template section" },
        { status: 500 }
      );
    }
    nextSort += 1;

    const lineRows = template.lines.map((line, i) => ({
      section_id: section.id,
      text: line.text,
      kind: line.kind,
      sort: i + 1,
    }));
    const { data: lines, error: linesError } = await supabase
      .from("sow_lines")
      .insert(lineRows)
      .select();
    if (linesError) {
      return NextResponse.json({ error: linesError.message }, { status: 500 });
    }

    createdSections.push({
      ...(section as SowSectionWithLines),
      lines: (lines ?? []).sort((a, b) => a.sort - b.sort),
    });
  }

  const payload: ApplyTemplateResponse = { sections: createdSections };
  return NextResponse.json(payload, { status: 201 });
}
