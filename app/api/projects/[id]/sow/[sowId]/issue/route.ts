import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { SowDocument } from "@/types";

/**
 * POST /api/projects/[id]/sow/[sowId]/issue
 * Sets status='issued' + stamps issued_at. Once issued, the revision
 * becomes immutable (BUILD-SPEC.md "Scope of Works builder": "issue
 * action sets status='issued' + revision immutable — editing an issued
 * SOW requires 'New revision'") — every section/line write route in
 * this feature checks the parent SOW's status and 409s once it's
 * issued. Also flips the project's scope_of_works traffic light to
 * 'done' automatically, per "traffic light reflects SOW status
 * automatically: draft SOW → 'draft', issued → 'done'" — this is a
 * direct write here rather than routing through
 * PATCH /api/projects/[id]/document-status so issuing a SOW can't be
 * silently skipped by a client that forgets the second call.
 *
 * No-ops (400) if already issued — issuing twice makes no sense and
 * would otherwise silently re-stamp issued_at. Team access.
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

  const { data: sow, error: fetchError } = await supabase
    .from("sow_documents")
    .select("*")
    .eq("id", sowId)
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .single();
  if (fetchError || !sow) {
    return NextResponse.json({ error: "SOW not found" }, { status: 404 });
  }
  if ((sow as SowDocument).status === "issued") {
    return NextResponse.json({ error: "This SOW has already been issued." }, { status: 400 });
  }

  const { data: updated, error } = await supabase
    .from("sow_documents")
    .update({ status: "issued", issued_at: new Date().toISOString() })
    .eq("id", sowId)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const { data: project } = await supabase
    .from("projects")
    .select("document_status")
    .eq("id", projectId)
    .single();
  if (project) {
    const merged = {
      ...(project.document_status ?? {}),
      scope_of_works: "done",
    };
    await supabase.from("projects").update({ document_status: merged }).eq("id", projectId);
  }

  return NextResponse.json({ sow: updated as SowDocument });
}
