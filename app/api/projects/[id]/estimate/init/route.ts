import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { sectionRollup } from "@/lib/estimate";
import type { CostSectionWithLines } from "@/types";

/**
 * POST /api/projects/[id]/estimate/init
 * Seeds a project's cost_sections + cost_lines from the default master
 * estimate template (supabase/seed_estimate_template.sql), plus the
 * default measurement groups (Floor Areas, Tiling Areas) per
 * BUILD-SPEC.md "Areas & Measurements ... groups editable ... Floor
 * Areas, Tiling Areas seeded as default groups on init".
 *
 * Idempotent: if the project already has any cost_sections, returns
 * 409 rather than duplicating — the "Initialise from template" button
 * in the UI only ever shows on the empty state, but the route itself
 * is the actual guard (never trust the client not to double-click).
 *
 * Admin-only (BUILD-SPEC.md §Financial visibility): the entire Estimate
 * surface is financial data, so non-admins get 403 before any query.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
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

  const { data: project } = await supabase
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .single();
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const { count: existingCount } = await supabase
    .from("cost_sections")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId);
  if (existingCount && existingCount > 0) {
    return NextResponse.json(
      { error: "Estimate already initialised for this project" },
      { status: 409 }
    );
  }

  const { data: template } = await supabase
    .from("estimate_templates")
    .select("id")
    .eq("is_default", true)
    .single();
  if (!template) {
    return NextResponse.json(
      { error: "No default estimate template found — run supabase/seed_estimate_template.sql" },
      { status: 500 }
    );
  }

  const { data: templateSections, error: sectionsError } = await supabase
    .from("estimate_template_sections")
    .select("id, name, sort, estimate_template_lines(id, description, unit, sort)")
    .eq("template_id", template.id)
    .order("sort", { ascending: true });

  if (sectionsError) {
    return NextResponse.json({ error: sectionsError.message }, { status: 500 });
  }

  const createdSections: CostSectionWithLines[] = [];

  // Sequential to keep failure handling simple and avoid interleaved
  // sort-order writes on a low-frequency, admin-only, one-shot action —
  // performance is not a concern here (22 sections, 178 lines total).
  for (const templateSection of templateSections ?? []) {
    const { data: section, error: sectionError } = await supabase
      .from("cost_sections")
      .insert({
        project_id: projectId,
        name: templateSection.name,
        sort: templateSection.sort,
      })
      .select()
      .single();
    if (sectionError || !section) {
      return NextResponse.json(
        { error: sectionError?.message ?? "Failed to create section" },
        { status: 500 }
      );
    }

    const templateLines = (
      (templateSection as unknown as {
        estimate_template_lines: { id: string; description: string; unit: string | null; sort: number }[];
      }).estimate_template_lines ?? []
    ).sort((a, b) => a.sort - b.sort);

    let lines: CostSectionWithLines["lines"] = [];
    if (templateLines.length > 0) {
      const { data: insertedLines, error: linesError } = await supabase
        .from("cost_lines")
        .insert(
          templateLines.map((tl) => ({
            section_id: section.id,
            project_id: projectId,
            description: tl.description,
            unit: tl.unit,
            sort: tl.sort,
          }))
        )
        .select();
      if (linesError) {
        return NextResponse.json({ error: linesError.message }, { status: 500 });
      }
      lines = (insertedLines ?? []).sort((a, b) => a.sort - b.sort);
    }

    createdSections.push({
      ...section,
      lines,
      rollup: sectionRollup(lines),
    });
  }

  // Default measurement groups per BUILD-SPEC.md.
  await supabase.from("measurement_groups").insert([
    { project_id: projectId, name: "Floor Areas", sort: 1 },
    { project_id: projectId, name: "Tiling Areas", sort: 2 },
  ]);

  return NextResponse.json({ sections: createdSections }, { status: 201 });
}
