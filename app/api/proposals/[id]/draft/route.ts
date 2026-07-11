import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import type { PatchProposalDraftInput, Proposal, ProposalResponse } from "@/types/proposals";

export const runtime = "nodejs";

/**
 * PATCH /api/proposals/[id]/draft
 * BUILD-SPEC.md item 5: "MCP tools get_proposal, set_proposal_draft
 * (updates content.letter/content.vision ONLY and ONLY while
 * status='draft')." This is that route — deliberately separate from
 * the general PATCH /api/proposals/[id] (which any admin field group
 * in the Builder UI can hit), so the "letter/vision only, draft only"
 * restriction is enforced at the API layer for EVERY caller (Aria via
 * MCP, or a future direct call) rather than only by the MCP tool's own
 * description/discipline. Same admin gate as every other proposals
 * route — Aria authenticates as a real admin user (docs/ARIA.md).
 *
 * Body: PatchProposalDraftInput — { letter?, vision? }, at least one
 * required. Merges into content (never replaces the whole content
 * object — every other field, scope/fees/timeline/exclusions/terms,
 * is untouched), and does NOT recompute total_inc (nothing here can
 * touch content.fees).
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (info.role !== "admin") {
    return NextResponse.json({ error: "Only admins (including Aria) can draft proposal content" }, { status: 403 });
  }

  const { data: existing } = await supabase.from("proposals").select("id,status,content").eq("id", id).maybeSingle();
  if (!existing) return NextResponse.json({ error: "Proposal not found" }, { status: 404 });
  if (existing.status !== "draft") {
    return NextResponse.json(
      { error: "set_proposal_draft can only update a proposal while it is still status='draft'." },
      { status: 409 }
    );
  }

  let body: PatchProposalDraftInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const hasLetter = typeof body.letter === "string";
  const hasVision = typeof body.vision === "string";
  if (!hasLetter && !hasVision) {
    return NextResponse.json({ error: "Provide letter and/or vision" }, { status: 400 });
  }

  const content = { ...(existing.content as Record<string, unknown>) };
  if (hasLetter) content.letter = body.letter;
  if (hasVision) content.vision = body.vision;

  const { data: updated, error } = await supabase
    .from("proposals")
    .update({ content })
    .eq("id", id)
    .select()
    .single();

  if (error || !updated) {
    return NextResponse.json({ error: error?.message ?? "Could not update draft" }, { status: 500 });
  }

  const responseBody: ProposalResponse = { proposal: updated as Proposal };
  return NextResponse.json(responseBody);
}
