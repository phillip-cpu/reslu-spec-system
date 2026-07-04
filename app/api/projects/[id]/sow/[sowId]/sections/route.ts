import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { CreateSowSectionInput, SowDocument } from "@/types";

/**
 * POST /api/projects/[id]/sow/[sowId]/sections
 * Adds a section to a SOW. Only allowed while the SOW is still
 * 'draft' — BUILD-SPEC.md "issue action sets status='issued' +
 * revision immutable — editing an issued SOW requires 'New revision'".
 * Team access.
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

  const { data: sow } = await supabase
    .from("sow_documents")
    .select("*")
    .eq("id", sowId)
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .single();
  if (!sow) {
    return NextResponse.json({ error: "SOW not found" }, { status: 404 });
  }
  if ((sow as SowDocument).status === "issued") {
    return NextResponse.json(
      { error: "This SOW has been issued and is immutable — use 'New revision' to edit it." },
      { status: 409 }
    );
  }

  let body: CreateSowSectionInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body?.heading?.trim()) {
    return NextResponse.json({ error: "heading is required" }, { status: 400 });
  }

  const { data: existing } = await supabase
    .from("sow_sections")
    .select("sort")
    .eq("sow_id", sowId)
    .order("sort", { ascending: false })
    .limit(1);
  const nextSort = (existing?.[0]?.sort ?? 0) + 1;

  const { data: section, error } = await supabase
    .from("sow_sections")
    .insert({ sow_id: sowId, heading: body.heading.trim(), sort: nextSort })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ section: { ...section, lines: [] } }, { status: 201 });
}
