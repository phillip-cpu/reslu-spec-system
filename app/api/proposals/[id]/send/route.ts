import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { sendProposalEmail } from "@/lib/proposal-emails";
import { recipientEmail, residenceLabel } from "@/lib/proposals";
import type { Proposal, ProposalResponse } from "@/types/proposals";

export const runtime = "nodejs";

/**
 * POST /api/proposals/[id]/send
 * Admin-only. Body: none. BUILD-SPEC.md item 3: "Send action: sets
 * status sent/sent_at, generates token (crypto, match existing token
 * style), sends email via sendOrQueue (Aria sender ..., email_sends
 * log, Adelaide window) ... link -> https://spec.reslu.com.au/proposal/{token}."
 *
 * The token is NOT generated here — migration 051 already mints one
 * (default encode(gen_random_bytes(32),'hex')) the moment the proposal
 * row is created, so the Builder UI's "Live preview" link is stable
 * and usable even before Send. This route reuses that same token; it
 * never rotates it (a rotate-on-send would break a preview link
 * already shared/opened before Send, with no upside).
 *
 * Requires status='draft' (guards a double-send — resending an
 * already-'sent' proposal is the separate, explicitly-named
 * POST /api/proposals/[id]/resend, item 6). Requires a recipient email
 * on file (lead.email or project.client_email — lib/proposals.ts's
 * recipientEmail()).
 *
 * Only lib/proposal-emails.ts's own sendProposalEmail() is used here —
 * NOT lib/visit-emails.ts's sendOrQueue() directly, since that
 * function's own record_type/template unions don't (and, per this
 * round's file boundary, can't) include 'proposal'/'proposal-sent' —
 * see that module's own header comment for the full reasoning. It
 * reuses that module's merge()/sendViaResend()/window-gate exports
 * unmodified.
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (info.role !== "admin") {
    return NextResponse.json({ error: "Only admins can send fee proposals" }, { status: 403 });
  }

  const { data: proposal, error: fetchError } = await supabase
    .from("proposals")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (fetchError) return NextResponse.json({ error: fetchError.message }, { status: 500 });
  if (!proposal) return NextResponse.json({ error: "Proposal not found" }, { status: 404 });
  if (proposal.status !== "draft") {
    return NextResponse.json(
      { error: `This proposal is already ${proposal.status} — use resend to send it again.` },
      { status: 409 }
    );
  }

  const [{ data: lead }, { data: project }] = await Promise.all([
    proposal.lead_id
      ? supabase
          .from("leads")
          .select("id,first_name,surname_project,email,location")
          .eq("id", proposal.lead_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    proposal.project_id
      ? supabase.from("projects").select("id,name,alias,client_name,client_email,address").eq("id", proposal.project_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const to = recipientEmail({ lead, project });
  if (!to) {
    return NextResponse.json(
      { error: "No recipient email on file for this lead/project — add one before sending." },
      { status: 400 }
    );
  }

  const residence = residenceLabel({ lead, project });
  const greetingName = project?.client_name || lead?.first_name || lead?.surname_project || "there";
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://spec.reslu.com.au";
  const proposalLink = `${appUrl}/proposal/${proposal.token}`;

  // Status flips to 'sent' before the email attempt — same "the
  // envelope is sent" convention POST /api/projects/[id]/trade-requests
  // uses (049): a queued-outside-window or even a failed Resend call
  // still means Phillip pressed Send, and the follow-up clock
  // (sent_at) should start now regardless of the transport outcome.
  const now = new Date();
  const { data: updated, error: updateError } = await supabase
    .from("proposals")
    .update({ status: "sent", sent_at: now.toISOString() })
    .eq("id", id)
    .select()
    .single();
  if (updateError || !updated) {
    return NextResponse.json({ error: updateError?.message ?? "Could not mark proposal as sent" }, { status: 500 });
  }

  const emailResult = await sendProposalEmail(supabase, {
    proposalId: proposal.id,
    to: [to],
    subject: `RESLU · your fee proposal — ${residence}`,
    mergeData: {
      company: greetingName,
      project_name: residence,
      project_address: project?.address ?? lead?.location ?? "",
      request_link: proposalLink,
      attachments_note: "",
    },
    now,
  });

  const responseBody: ProposalResponse & { email: typeof emailResult } = {
    proposal: updated as Proposal,
    email: emailResult,
  };
  return NextResponse.json(responseBody);
}
