import { NextRequest, NextResponse } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { createClient } from "@/lib/supabase/server";
import { SowPdf } from "@/components/pdf/SowPdf";
import type { SowDocument, SowSectionWithLines } from "@/types";

// react-pdf + font/logo file reads require the Node runtime — same as
// GET /api/projects/[id]/pdf.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/projects/[id]/sow/[sowId]/pdf
 * Renders the branded Scope of Works PDF for one revision (BUILD-SPEC.md
 * "Scope of Works builder": "rendered to branded PDF"). Team access —
 * a SOW is not financial data.
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

  const [{ data: project }, { data: sow, error: sowError }] = await Promise.all([
    // job_number added (migration 028_job_numbers.sql) — see projectNo
    // below, which now prefers the real assigned number.
    supabase.from("projects").select("id,name,client_name,address,job_number").eq("id", projectId).single(),
    supabase
      .from("sow_documents")
      .select("*")
      .eq("id", sowId)
      .eq("project_id", projectId)
      .is("deleted_at", null)
      .single(),
  ]);

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  if (sowError || !sow) {
    return NextResponse.json({ error: "SOW not found" }, { status: 404 });
  }
  const typedSow = sow as SowDocument;

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

  const generatedAt = new Date().toLocaleDateString("en-AU", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  // The build spec's cover reference lists a "Project No." field.
  // Migration 028_job_numbers.sql introduced a real numbering scheme
  // (projects.job_number, auto-assigned on create, overridable in
  // Settings) — this is now the primary source. The short id-prefix
  // stand-in (pre-migration-028 behaviour) is kept as a fallback only
  // for the edge case of a project whose job_number is still null
  // (shouldn't happen post-backfill, but a defensive fallback here
  // costs nothing and avoids ever rendering a blank "Project No." line).
  const projectNo = project.job_number ?? projectId.slice(0, 8).toUpperCase();

  const buffer = await renderToBuffer(
    SowPdf({
      project,
      sections: sectionsWithLines,
      revisionLabel: typedSow.revision_label,
      status: typedSow.status,
      issuedAt: typedSow.issued_at,
      projectNo,
      generatedAt,
    })
  );

  const filename = `${project.name.replace(/[^a-z0-9]+/gi, "-")}-SOW-${typedSow.revision_label}.pdf`;

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
