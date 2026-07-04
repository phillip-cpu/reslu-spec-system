import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isValidDocumentStatus } from "@/lib/sow";
import type { PatchDocumentStatusInput, Project, ProjectFileKind } from "@/types";

const KINDS: ProjectFileKind[] = ["plans", "council", "engineering", "scope_of_works", "other"];

/**
 * PATCH /api/projects/[id]/document-status
 * Sets a single kind's traffic-light status in projects.document_status
 * (jsonb, migration 011_sow_overview.sql). Team access — NOT
 * admin-gated, per BUILD-SPEC.md "Project overview hub": a document's
 * completion status isn't financial data, same trust tier as
 * project_files. Body: { kind, status }. Merges into the existing
 * jsonb rather than replacing it, so setting one kind never clobbers
 * another's status.
 */
export async function PATCH(
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

  let body: PatchDocumentStatusInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body?.kind || !KINDS.includes(body.kind)) {
    return NextResponse.json(
      { error: `kind must be one of ${KINDS.join(", ")}` },
      { status: 400 }
    );
  }
  if (!isValidDocumentStatus(body.status)) {
    return NextResponse.json(
      { error: "status must be one of na, not_started, draft, done" },
      { status: 400 }
    );
  }

  const { data: project, error: fetchError } = await supabase
    .from("projects")
    .select("document_status")
    .eq("id", projectId)
    .single();
  if (fetchError || !project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const merged = {
    ...((project as Pick<Project, "document_status">).document_status ?? {}),
    [body.kind]: body.status,
  };

  const { data: updated, error } = await supabase
    .from("projects")
    .update({ document_status: merged })
    .eq("id", projectId)
    .select("document_status")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ document_status: updated.document_status });
}
