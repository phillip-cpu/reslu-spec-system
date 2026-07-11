import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { computeProposalTotal, validateProposalContent } from "@/lib/proposals";
import type { PatchProposalInput, Proposal, ProposalResponse } from "@/types/proposals";

export const runtime = "nodejs";

/**
 * GET /api/proposals/[id]
 * Admin-only (see app/api/proposals/route.ts's own gating comment).
 * Also the thin-fetch target of the MCP get_proposal tool (Aria
 * authenticates as a real admin user — docs/ARIA.md — so this same
 * gate covers her too, no separate branch needed).
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (info.role !== "admin") {
    return NextResponse.json({ error: "Only admins can access fee proposals" }, { status: 403 });
  }

  const { data: proposal, error } = await supabase.from("proposals").select("*").eq("id", id).maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!proposal) return NextResponse.json({ error: "Proposal not found" }, { status: 404 });

  const body: ProposalResponse = { proposal: proposal as Proposal };
  return NextResponse.json(body);
}

/**
 * PATCH /api/proposals/[id]
 * Admin-only. Body: PatchProposalInput — { content?, deposit_inc? }.
 * This is the Builder UI's draft-commit-on-blur save target
 * (components/proposals/ProposalEditor.tsx): every field group PATCHes
 * the WHOLE content object on blur, never per-keystroke — see that
 * component's own header comment for why a single-blob PATCH is the
 * right granularity here (unlike SowBuilder/EstimateView, which PATCH
 * one row at a time because their content actually lives in separate
 * DB rows; a proposal's content is one jsonb blob with no sub-row ids).
 *
 * total_inc is ALWAYS server-recomputed from content.fees when content
 * is provided (never accepted from the client — same posture as
 * migration 051's own column comment). deposit_inc, when provided, is
 * stored as-is (a plain editable field — see that same comment for why
 * it is NOT re-derived from total_inc after its initial default).
 *
 * Blocked once status is 'accepted' or 'closed' — the signed document
 * (and the PDF/invoice generated from it) must never drift after a
 * client has signed. Freely editable while 'draft' or 'sent' (an admin
 * catching a typo after Send but before the client has signed is a
 * legitimate, common edit — this route does not reset status/sent_at
 * when that happens, per this round's own build instructions not
 * specifying any such reset).
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (info.role !== "admin") {
    return NextResponse.json({ error: "Only admins can edit fee proposals" }, { status: 403 });
  }

  const { data: existing } = await supabase.from("proposals").select("id,status").eq("id", id).maybeSingle();
  if (!existing) return NextResponse.json({ error: "Proposal not found" }, { status: 404 });
  if (existing.status === "accepted" || existing.status === "closed") {
    return NextResponse.json(
      { error: `A ${existing.status} proposal cannot be edited.` },
      { status: 409 }
    );
  }

  let body: PatchProposalInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const patch: Record<string, unknown> = {};

  if (body.content !== undefined) {
    const reason = validateProposalContent(body.content);
    if (reason) return NextResponse.json({ error: reason }, { status: 400 });
    patch.content = body.content;
    patch.total_inc = computeProposalTotal(body.content.fees);
  }

  if (body.deposit_inc !== undefined) {
    const deposit = Number(body.deposit_inc);
    if (!Number.isFinite(deposit) || deposit < 0) {
      return NextResponse.json({ error: "deposit_inc must be a non-negative number" }, { status: 400 });
    }
    patch.deposit_inc = deposit;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const { data: updated, error } = await supabase
    .from("proposals")
    .update(patch)
    .eq("id", id)
    .select()
    .single();

  if (error || !updated) {
    return NextResponse.json({ error: error?.message ?? "Could not update proposal" }, { status: 500 });
  }

  const responseBody: ProposalResponse = { proposal: updated as Proposal };
  return NextResponse.json(responseBody);
}
