import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { latestProposalSentRow, sendProposalEmail } from "@/lib/proposal-emails";
import { recipientEmail, residenceLabel } from "@/lib/proposals";
import type { Proposal, ProposalResponse } from "@/types/proposals";

export const runtime = "nodejs";

/** Minimum gap between two resends of the SAME proposal — a simple
 * time-window dupe guard against a double-click/double-tap on the
 * resend button (BUILD-SPEC.md item 6: "re-send route (same token,
 * email_sends dupe guard)"). Deliberately NOT the atomic claim-function
 * shape trade_booking_requests' claim_trade_request_resend() (049)
 * uses — that fix exists because that flow's own last_resend_at column
 * exists specifically to back it; migration 051's own column list
 * (BUILD-SPEC.md item 1, followed exactly) has no equivalent column, so
 * this route checks the latest email_sends row's timestamp instead (a
 * SELECT-then-guard, not perfectly race-proof against two
 * simultaneous admin tabs, but this is a rare, deliberate manual admin
 * action — the same risk profile trade-request resend had BEFORE its
 * own atomic-guard fix was found necessary). */
const RESEND_GUARD_MS = 60_000;

/**
 * Same reused-{{visit_date}}-slot technique as
 * app/api/proposals/[id]/send/route.ts's own formatSentDateAdelaide()
 * (kept as a small, deliberate per-route duplicate — same "independent
 * pipelines, independent tiny helpers" precedent lib/proposal-emails.ts's
 * header comment already documents for this round's other files). A
 * resend shows the date printed on the ORIGINAL packet, not today's date
 * — sent_at never moves on resend (see this route's own doc comment on
 * why), and the card's date shouldn't either.
 */
function formatSentDateAdelaide(d: Date): string {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Adelaide",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(d);
}

/**
 * POST /api/proposals/[id]/resend
 * Admin-only. Same token/link as the original send (BUILD-SPEC.md item
 * 6) — re-sends the 'proposal-sent' email without touching sent_at
 * (the >5-day follow-up clock keeps counting from the ORIGINAL send,
 * same discipline as trade_booking_requests.sent_at/last_resend_at,
 * 049). Requires status='sent' (an accepted/closed/draft proposal has
 * nothing to resend).
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (info.role !== "admin") {
    return NextResponse.json({ error: "Only admins can resend fee proposals" }, { status: 403 });
  }

  const { data: proposal, error: fetchError } = await supabase
    .from("proposals")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (fetchError) return NextResponse.json({ error: fetchError.message }, { status: 500 });
  if (!proposal) return NextResponse.json({ error: "Proposal not found" }, { status: 404 });
  if (proposal.status !== "sent") {
    return NextResponse.json(
      { error: `Only a sent (not yet accepted) proposal can be resent — this one is ${proposal.status}.` },
      { status: 409 }
    );
  }

  const lastSend = await latestProposalSentRow(supabase, id);
  if (lastSend && lastSend.status === "sent" && lastSend.sent_at) {
    const elapsed = Date.now() - new Date(lastSend.sent_at).getTime();
    if (elapsed < RESEND_GUARD_MS) {
      return NextResponse.json(
        { error: "This proposal was just resent — please wait a moment before trying again." },
        { status: 429 }
      );
    }
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
      { error: "No recipient email on file for this lead/project — add one before resending." },
      { status: 400 }
    );
  }

  const residence = residenceLabel({ lead, project });
  const greetingName = project?.client_name || lead?.first_name || lead?.surname_project || "there";
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://spec.reslu.com.au";
  const proposalLink = `${appUrl}/proposal/${proposal.token}`;

  const emailResult = await sendProposalEmail(supabase, {
    proposalId: proposal.id,
    to: [to],
    subject: `RESLU · your fee proposal — ${residence} (a reminder)`,
    mergeData: {
      company: greetingName,
      project_name: residence,
      project_address: project?.address ?? lead?.location ?? "",
      request_link: proposalLink,
      attachments_note: "",
      visit_date: formatSentDateAdelaide(proposal.sent_at ? new Date(proposal.sent_at) : new Date()),
    },
  });

  const responseBody: ProposalResponse & { email: typeof emailResult } = {
    proposal: proposal as Proposal,
    email: emailResult,
  };
  return NextResponse.json(responseBody);
}
