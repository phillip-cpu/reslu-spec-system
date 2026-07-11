import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { proposalTemplateContent } from "@/lib/proposal-templates";
import { computeProposalTotal, defaultDepositInc } from "@/lib/proposals";
import type {
  CreateProposalInput,
  Proposal,
  ProposalListResponse,
  ProposalResponse,
  ProposalTemplateKind,
} from "@/types/proposals";

export const runtime = "nodejs";

const TEMPLATE_KINDS: ProposalTemplateKind[] = ["renovation", "new_build", "multi_phase"];

/**
 * GET /api/proposals?lead_id=&project_id=
 * Admin-only (fee proposals carry design-fee/pricing data — same
 * whole-route admin gate as client_invoices/leads, per BUILD-SPEC.md
 * §Security). Lists proposals for a lead or a project, newest first —
 * the "Fee proposal" section on LeadDetailPanel (and the equivalent
 * project surface) both call this with one of the two filters set.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (info.role !== "admin") {
    return NextResponse.json({ error: "Only admins can access fee proposals" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const leadId = searchParams.get("lead_id");
  const projectId = searchParams.get("project_id");

  let query = supabase.from("proposals").select("*").order("created_at", { ascending: false });
  if (leadId) query = query.eq("lead_id", leadId);
  if (projectId) query = query.eq("project_id", projectId);
  if (!leadId && !projectId) {
    return NextResponse.json({ error: "lead_id or project_id is required" }, { status: 400 });
  }

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const body: ProposalListResponse = { proposals: (data ?? []) as Proposal[] };
  return NextResponse.json(body);
}

/**
 * POST /api/proposals
 * Admin-only. Body: CreateProposalInput — { lead_id?, project_id?,
 * template }. At least one of lead_id/project_id is required (matches
 * migration 051's own chk_proposals_lead_or_project). Seeds content
 * from lib/proposal-templates.ts's proposalTemplateContent(), computes
 * total_inc/deposit_inc from that seed's (zero-amount) fee stages —
 * both land at 0 until the admin fills in real numbers in the Builder
 * UI — and starts at status='draft'.
 *
 * Aria pre-draft (BUILD-SPEC.md item 5): when the proposal is raised
 * from a lead (lead_id set) AND that lead has brief_answers on file,
 * inserts one aria_queue row (kind='draft_proposal', dedupe_key
 * `draft_proposal:{proposal_id}` so a retry never double-queues the
 * same proposal). Aria drafts content.letter/content.vision via the
 * set_proposal_draft MCP tool (see app/api/proposals/[id]/draft/route.ts)
 * — Phillip always reviews/edits before Send; nothing here or in that
 * tool can send a proposal.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (info.role !== "admin") {
    return NextResponse.json({ error: "Only admins can create fee proposals" }, { status: 403 });
  }

  let body: CreateProposalInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const lead_id = typeof body.lead_id === "string" && body.lead_id ? body.lead_id : null;
  const project_id = typeof body.project_id === "string" && body.project_id ? body.project_id : null;
  if (!lead_id && !project_id) {
    return NextResponse.json({ error: "lead_id or project_id is required" }, { status: 400 });
  }
  if (!TEMPLATE_KINDS.includes(body.template)) {
    return NextResponse.json(
      { error: `template must be one of ${TEMPLATE_KINDS.join(", ")}` },
      { status: 400 }
    );
  }

  let lead: { id: string; brief_answers: unknown } | null = null;
  if (lead_id) {
    const { data } = await supabase
      .from("leads")
      .select("id,brief_answers")
      .eq("id", lead_id)
      .is("deleted_at", null)
      .maybeSingle();
    if (!data) return NextResponse.json({ error: "Lead not found" }, { status: 404 });
    lead = data;
  }
  if (project_id) {
    const { data: project } = await supabase.from("projects").select("id").eq("id", project_id).maybeSingle();
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const content = proposalTemplateContent(body.template);
  const total_inc = computeProposalTotal(content.fees);
  const deposit_inc = defaultDepositInc(total_inc);

  const { data: proposal, error } = await supabase
    .from("proposals")
    .insert({
      lead_id,
      project_id,
      content,
      total_inc,
      deposit_inc,
    })
    .select()
    .single();

  if (error || !proposal) {
    return NextResponse.json({ error: error?.message ?? "Could not create proposal" }, { status: 500 });
  }

  if (lead?.brief_answers) {
    await supabase.from("aria_queue").insert({
      kind: "draft_proposal",
      payload: { proposal_id: proposal.id, lead_id: lead.id },
      dedupe_key: `draft_proposal:${proposal.id}`,
      source: "proposal-create",
    });
  }

  const responseBody: ProposalResponse = { proposal: proposal as Proposal };
  return NextResponse.json(responseBody, { status: 201 });
}
