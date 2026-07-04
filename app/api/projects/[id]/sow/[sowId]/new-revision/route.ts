import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { nextRevisionLabel } from "@/lib/sow";
import type { SowDocument, SowLine, SowSection } from "@/types";

/**
 * POST /api/projects/[id]/sow/[sowId]/new-revision
 * Clones an issued SOW's sections + lines into a brand-new draft SOW
 * at the next T-number (T1 -> T2 -> ...), per BUILD-SPEC.md "Scope of
 * Works builder": "editing an issued SOW requires 'New revision' which
 * clones to next T-number draft". Only valid from an issued SOW — a
 * draft SOW is already editable in place, so cloning it would just
 * create a confusing duplicate; 400s instead.
 *
 * The source SOW is left untouched (still issued, still immutable) —
 * this is a pure clone, not a "reopen for editing" operation, which
 * matters for the audit trail: what was actually issued to the client
 * for T1 must remain exactly as issued even after T2 exists.
 *
 * Team access.
 */
export async function POST(
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

  const { data: source, error: sourceError } = await supabase
    .from("sow_documents")
    .select("*")
    .eq("id", sowId)
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .single();
  if (sourceError || !source) {
    return NextResponse.json({ error: "SOW not found" }, { status: 404 });
  }
  const typedSource = source as SowDocument;
  if (typedSource.status !== "issued") {
    return NextResponse.json(
      { error: "Only an issued SOW can be cloned into a new revision — this one is still a draft." },
      { status: 400 }
    );
  }

  const { data: sourceSections, error: sectionsError } = await supabase
    .from("sow_sections")
    .select("*, sow_lines(*)")
    .eq("sow_id", sowId)
    .order("sort", { ascending: true });
  if (sectionsError) {
    return NextResponse.json({ error: sectionsError.message }, { status: 500 });
  }

  // Compute the next free T-number against every existing (incl.
  // soft-deleted) revision label for this project, not just
  // nextRevisionLabel(current) — guards against out-of-order issuing
  // (e.g. cloning T1 after a T3 already exists via some other path)
  // colliding with the partial-unique index.
  const { data: allRevisions } = await supabase
    .from("sow_documents")
    .select("revision_label")
    .eq("project_id", projectId);
  const existingLabels = new Set((allRevisions ?? []).map((r) => r.revision_label as string));
  let candidate = nextRevisionLabel(typedSource.revision_label);
  while (existingLabels.has(candidate)) {
    candidate = nextRevisionLabel(candidate);
  }

  const { data: newSow, error: newSowError } = await supabase
    .from("sow_documents")
    .insert({
      project_id: projectId,
      revision_label: candidate,
      status: "draft",
      created_by: user.id,
    })
    .select()
    .single();
  if (newSowError || !newSow) {
    return NextResponse.json(
      { error: newSowError?.message ?? "Could not create the new revision" },
      { status: 500 }
    );
  }

  for (const section of (sourceSections ?? []) as (SowSection & { sow_lines: SowLine[] })[]) {
    const { data: newSection, error: newSectionError } = await supabase
      .from("sow_sections")
      .insert({ sow_id: newSow.id, heading: section.heading, sort: section.sort })
      .select()
      .single();
    if (newSectionError || !newSection) {
      await supabase.from("sow_documents").delete().eq("id", newSow.id);
      return NextResponse.json(
        { error: newSectionError?.message ?? "Could not clone a section" },
        { status: 500 }
      );
    }

    const lines = section.sow_lines ?? [];
    if (lines.length > 0) {
      const { error: linesError } = await supabase.from("sow_lines").insert(
        lines.map((l) => ({
          section_id: newSection.id,
          text: l.text,
          kind: l.kind,
          sort: l.sort,
        }))
      );
      if (linesError) {
        await supabase.from("sow_documents").delete().eq("id", newSow.id);
        return NextResponse.json({ error: linesError.message }, { status: 500 });
      }
    }
  }

  // The new draft supersedes the issued one as the "current" SOW —
  // reflect that on the traffic light immediately (draft → amber)
  // rather than leaving it showing 'done' from the now-superseded
  // issued revision until the new one is itself issued.
  const { data: project } = await supabase
    .from("projects")
    .select("document_status")
    .eq("id", projectId)
    .single();
  if (project) {
    const merged = { ...(project.document_status ?? {}), scope_of_works: "draft" };
    await supabase.from("projects").update({ document_status: merged }).eq("id", projectId);
  }

  return NextResponse.json({ sow: newSow as SowDocument }, { status: 201 });
}
