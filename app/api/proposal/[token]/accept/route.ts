import { NextRequest, NextResponse } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/rate-limit";
import { ASSET_BUCKET } from "@/lib/storage";
import { decodePngDataUrl } from "@/lib/signatures";
import { cleanLineItems, computeTotals, nextInvoiceNumber } from "@/lib/client-invoices";
import { depositExGst, proposalPdfPath, recipientEmail, residenceLabel } from "@/lib/proposals";
import { sendViaResend } from "@/lib/resend";
import { reportError } from "@/lib/report-error";
import { sendPushToAdmins } from "@/lib/push";
import { closeBriefItem } from "@/lib/daily-brief-close";
import { ProposalPdf } from "@/components/pdf/ProposalPdf";
import type {
  AcceptProposalInput,
  AcceptProposalResponse,
  Proposal,
  ProposalSignature,
} from "@/types/proposals";

export const runtime = "nodejs";

const PROPOSAL_FROM = "Aria — RESLU <aria@reslu.com.au>";
const PROPOSAL_REPLY_TO = "phillip@reslu.com.au";
const PHILLIP_EMAIL = "phillip@reslu.com.au";

// Same 5MB guard as app/api/client-invoices/[id]/send/route.ts — a
// proposal PDF should never legitimately be anywhere near that large;
// past it is far more likely a rendering bug than a real document.
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

function clientIp(request: NextRequest): string {
  const fwd = request.headers.get("x-forwarded-for");
  return fwd?.split(",")[0]?.trim() || "unknown";
}

/**
 * POST /api/proposal/[token]/accept
 *
 * BUILD-SPEC.md §"Fee proposal phase (r23)" item 4: "Client signs on the
 * tokened page → signed PDF stored + emailed → deposit invoice
 * auto-DRAFTED (never auto-sent) via 046 machinery → attention item."
 *
 * Public, token-gated, rate-limited (same trust model as every other
 * portal-style route in this schema — the token is unguessable 32-byte
 * hex, service-role client bypasses RLS). Body: AcceptProposalInput —
 * { drawn_data_url, typed_name, consent }. A drawn signature AND a
 * typed name are BOTH required (unlike the pre-existing e-signature
 * machinery's "draw AND/OR type" — this round's own migration 051
 * comment on the `signature` column captures both unconditionally,
 * simpler than re-deriving an AND/OR rule for a document type that
 * only ever has the one accept action, never a re-open/re-sign path).
 * consent must be exactly `true`.
 *
 * IDEMPOTENCY (double-POST safe): the actual status/signature write
 * below is a CONDITIONAL update — `.eq("status", "sent")` — so of any
 * two concurrent (or retried) POSTs for the same token, only ONE can
 * ever actually flip the row to 'accepted'. The other observes 0 rows
 * affected and falls through to the SAME `already_accepted: true`
 * response an already-accepted proposal's re-POST gets. This is the
 * real guard against a duplicate signed PDF, duplicate deposit invoice,
 * or duplicate email — not a separate "have we done this before" flag,
 * since the conditional UPDATE itself is the atomic single-winner gate.
 *
 * Everything AFTER that winning update (PDF render+store, deposit
 * invoice draft, confirmation email, daily_brief_items row) runs
 * exactly once, in the one request that won the claim — never retried
 * on a later re-POST (which short-circuits above before reaching any
 * of it). Each step is wrapped so a failure is reported
 * (lib/report-error.ts) but never turns this response into an error —
 * the client's signature is already durably recorded by the point any
 * of this runs, mirroring app/api/portal/[token]/sign/[requestId]/route.ts's
 * own "the evidence row is the real record; certificate/email are
 * best-effort" posture exactly. A failure here is a known, documented
 * gap (not silently papered over) — see this round's own final report.
 *
 * MIDDLEWARE: see app/proposal/[token]/page.tsx's own header comment
 * for the exact boundary-aware `isPublicPath` lines Claude Code needs
 * to add to lib/supabase/middleware.ts (protected/read-only for this
 * round) — `pathname.startsWith("/api/proposal/")` covers this route
 * too, without also exposing the admin-only `/api/proposals` CRUD API.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;

  const limit = rateLimit(`proposal-accept:${token}:${clientIp(request)}`, 10, 60_000);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } }
    );
  }

  let body: AcceptProposalInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (body.consent !== true) {
    return NextResponse.json(
      { error: "You must accept the consent statement to sign." },
      { status: 400 }
    );
  }
  const typedName = body.typed_name?.trim();
  if (!typedName) {
    return NextResponse.json({ error: "Full name is required." }, { status: 400 });
  }
  const signatureBytes = decodePngDataUrl(body.drawn_data_url ?? "");
  if (!signatureBytes || signatureBytes.byteLength === 0) {
    return NextResponse.json({ error: "A drawn signature is required." }, { status: 400 });
  }

  const supabase = createServiceRoleClient();

  const { data: proposal } = await supabase
    .from("proposals")
    .select("*")
    .eq("token", token)
    .maybeSingle();
  if (!proposal) {
    return NextResponse.json({ error: "Invalid link" }, { status: 404 });
  }

  if (proposal.status === "accepted") {
    const already: AcceptProposalResponse = { ok: true, status: "accepted", already_accepted: true };
    return NextResponse.json(already);
  }
  if (proposal.status !== "sent") {
    return NextResponse.json(
      { error: `This proposal is ${proposal.status} and cannot be signed.` },
      { status: 409 }
    );
  }

  const ip = clientIp(request);
  const userAgent = request.headers.get("user-agent");
  const signedAt = new Date();
  const signature: ProposalSignature = {
    drawn_data_url: body.drawn_data_url,
    typed_name: typedName,
    consent: true,
    ip: ip === "unknown" ? null : ip,
    user_agent: userAgent,
  };

  // The atomic claim — see this route's own header comment above.
  const { data: claimed, error: claimError } = await supabase
    .from("proposals")
    .update({
      status: "accepted",
      signed_name: typedName,
      signed_at: signedAt.toISOString(),
      signature,
    })
    .eq("id", proposal.id)
    .eq("status", "sent")
    .select()
    .maybeSingle();

  if (claimError) {
    return NextResponse.json(
      { error: `Could not record acceptance: ${claimError.message}` },
      { status: 500 }
    );
  }
  if (!claimed) {
    // Lost the race to a concurrent request — same response as the
    // already-accepted branch above.
    const already: AcceptProposalResponse = { ok: true, status: "accepted", already_accepted: true };
    return NextResponse.json(already);
  }

  const proposalRow = claimed as Proposal;

  // ------------------------------------------------------------
  // Best-effort from here — never fails the response. See header
  // comment for why.
  // ------------------------------------------------------------
  try {
    const [{ data: lead }, { data: project }] = await Promise.all([
      proposalRow.lead_id
        ? supabase
            .from("leads")
            .select("id,first_name,surname_project,email,location")
            .eq("id", proposalRow.lead_id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      proposalRow.project_id
        ? supabase
            .from("projects")
            .select("id,name,alias,job_number,client_name,client_email,address")
            .eq("id", proposalRow.project_id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

    const residence = residenceLabel({ lead, project });
    const address = project?.address ?? lead?.location ?? null;
    const clientName =
      project?.client_name ||
      [lead?.first_name, lead?.surname_project].filter(Boolean).join(" ") ||
      lead?.surname_project ||
      typedName;
    const toEmail = recipientEmail({ lead, project });

    const coverDateLabel = signedAt.toLocaleDateString("en-AU", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });

    // ---- 1. Render + store the signed PDF ----
    const pdfBuffer = await renderToBuffer(
      ProposalPdf({
        proposal: proposalRow,
        residence,
        address,
        clientName,
        coverDateLabel,
        signedDateLabel: coverDateLabel,
      })
    );
    const pdfPath = proposalPdfPath(proposalRow.id, signedAt);
    const { error: uploadError } = await supabase.storage
      .from(ASSET_BUCKET)
      .upload(pdfPath, pdfBuffer, { contentType: "application/pdf", upsert: false });

    if (uploadError) {
      await reportError("proposal-accept-pdf-upload", uploadError);
    } else {
      await supabase.from("proposals").update({ signed_pdf_path: pdfPath }).eq("id", proposalRow.id);
    }

    // ---- 2. Draft the deposit invoice via the 046 client-invoices
    // machinery (never auto-sent — starts and stays status='draft'
    // until an admin explicitly sends it, same as every other client
    // invoice). Guarded against duplication purely by the atomic claim
    // above (this code path runs at most once per proposal — see header
    // comment) — there is no proposal_id column on client_invoices
    // (migration 051 only adds the columns BUILD-SPEC.md item 1 lists),
    // so "created once" is a property of this route's own control flow,
    // not a second DB-level guard. ----
    try {
      const lineItems = cleanLineItems([
        {
          description: `Design fee deposit — ${residence}`,
          amount_ex_gst: depositExGst(proposalRow.deposit_inc),
        },
      ]);
      if (lineItems) {
        const totals = computeTotals(lineItems);
        const invoiceNumber = await nextInvoiceNumber(
          supabase,
          project ? { id: project.id, job_number: project.job_number ?? null } : null
        );
        await supabase.from("client_invoices").insert({
          project_id: project?.id ?? null,
          // BUILD-SPEC.md r27 item 7 — migration 054's lead_id column.
          // Only meaningful (and only ever set) when this invoice is
          // being created project_id-null (a lead-only proposal) — see
          // that column's own migration comment for the backfill this
          // enables once the lead becomes a project.
          lead_id: !project?.id && proposalRow.lead_id ? proposalRow.lead_id : null,
          invoice_number: invoiceNumber,
          kind: "design_fee",
          client_name: clientName,
          client_email: toEmail,
          address,
          line_items: lineItems,
          subtotal_ex_gst: totals.subtotal_ex_gst,
          gst: totals.gst,
          total_inc_gst: totals.total_inc_gst,
          notes: `Deposit for fee proposal accepted ${coverDateLabel}.`,
        });
      }
    } catch (err) {
      await reportError("proposal-accept-deposit-invoice", err);
    }

    // ---- 3. Email the signed copy to the client + Phillip ----
    try {
      const recipients = [toEmail, PHILLIP_EMAIL].filter((e): e is string => !!e);
      if (recipients.length > 0) {
        const base64 = Buffer.from(pdfBuffer).toString("base64");
        const attachmentTooLarge = pdfBuffer.byteLength > MAX_ATTACHMENT_BYTES;
        const subject = `RESLU · ${residence} — signed fee proposal`;
        const html = buildAcceptedEmailHtml(clientName, residence, attachmentTooLarge);

        const sendResult = await sendViaResend({
          from: PROPOSAL_FROM,
          to: recipients,
          replyTo: PROPOSAL_REPLY_TO,
          subject,
          html,
          attachments: attachmentTooLarge
            ? undefined
            : [{ filename: `RESLU-Proposal-${residence.replace(/[^a-z0-9]+/gi, "-")}.pdf`, content: base64 }],
        });
        await supabase.from("email_sends").insert({
          record_type: "proposal",
          record_id: proposalRow.id,
          template: "proposal-accepted",
          to_email: recipients.join(", "),
          status: sendResult.skipped ? "skipped" : "sent",
          sent_at: sendResult.skipped ? null : signedAt.toISOString(),
          detail: { subject, reason: sendResult.skipped ? sendResult.reason : undefined },
        });
      }
    } catch (err) {
      await reportError("proposal-accept-email", err);
      await supabase.from("email_sends").insert({
        record_type: "proposal",
        record_id: proposalRow.id,
        template: "proposal-accepted",
        to_email: [toEmail, PHILLIP_EMAIL].filter(Boolean).join(", "),
        status: "skipped",
        detail: { reason: "Send failed" },
      });
    }

    // ---- 4. Daily Brief attention item (dedupe-guarded — same "existing
    // open row" shape as POST /api/brief-submit/[token]'s own insert). ----
    const title = `Proposal accepted — ${residence}`;
    const linkHref = `/proposals/${proposalRow.id}`;
    const { data: existingOpen } = await supabase
      .from("daily_brief_items")
      .select("id")
      .eq("source", "proposal")
      .eq("link_href", linkHref)
      .eq("title", title)
      .eq("status", "open")
      .maybeSingle();
    if (!existingOpen) {
      await supabase.from("daily_brief_items").insert({
        title,
        source: "proposal",
        link_href: linkHref,
        status: "open",
        created_by_kind: "system",
      });
    }

    // ---- 4b. BUILD-SPEC.md r27 item 10 — Daily Brief self-close.
    // "proposal-accept related items": a lead-nurture attention row
    // ("Nurture — {surname_project} (Proposal Sent, no movement)" or
    // "Stale proposal — ...", both source='lead', link_href
    // `/leads?lead={id}` — see lib/daily-brief.ts's buildLeadCandidates())
    // may already be sitting open for this exact lead, flagging it as
    // having gone quiet. A client signing THIS proposal is unambiguous
    // movement, so close it — title is deliberately omitted from the
    // match (either of buildLeadCandidates()' two titles for this lead
    // is equally resolved by an acceptance). Only applies to a lead-
    // sourced proposal (proposalRow.project_id-only proposals have no
    // lead to look up). Best-effort, never blocks the accept above. ----
    if (proposalRow.lead_id) {
      await closeBriefItem(supabase, "lead", `/leads?lead=${proposalRow.lead_id}`);
    }

    // ---- 5. Health + web push round (r26), BUILD-SPEC.md item 3(b):
    // "proposal signed (r23 accept route)." Insert + push ONLY —
    // everything above (steps 1-4) is byte-identical to before this
    // round. Already inside this route's own best-effort try/catch
    // (see this function's header comment), so no separate one is
    // needed here. ----
    await supabase.from("notifications").insert({
      user_id: null,
      kind: "proposal_signed",
      title,
      body: null,
      link_href: linkHref,
    });
    await sendPushToAdmins("proposal_signed", title, "", linkHref);
  } catch (err) {
    // Belt-and-braces — nothing above should throw uncaught (each step
    // has its own try/catch), but if something unexpected does, it must
    // never turn an already-durably-recorded signature into an error
    // response for the client.
    await reportError("proposal-accept-post-signature", err);
  }

  const responseBody: AcceptProposalResponse = { ok: true, status: "accepted", already_accepted: false };
  return NextResponse.json(responseBody);
}

/** Simple branded HTML body, inline — no template file, mirroring
 * app/api/client-invoices/[id]/send/route.ts's own
 * buildInvoiceEmailHtml() (BUILD-SPEC.md this round's own precedent for
 * "attach the PDF directly, simple branded HTML body inline"). */
function buildAcceptedEmailHtml(clientName: string, residence: string, attachmentOmitted: boolean): string {
  const attachmentNote = attachmentOmitted
    ? `<p style="color:#313131;font-size:14px;">Your signed proposal's PDF was too large to attach directly — please contact ${PROPOSAL_REPLY_TO} for a copy.</p>`
    : `<p style="color:#313131;font-size:14px;">Your signed copy is attached as a PDF, for your records.</p>`;

  return `
    <div style="font-family:Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;">
      <p style="letter-spacing:2px;text-transform:uppercase;font-size:11px;color:#A08C72;font-weight:bold;">RESLU</p>
      <h1 style="font-size:22px;color:#1A1A1A;margin:8px 0 16px;">Thank you — ${escapeHtml(residence)}</h1>
      <p style="color:#313131;font-size:14px;">Hi ${escapeHtml(clientName)},</p>
      <p style="color:#313131;font-size:14px;">
        Thanks for signing your RESLU fee proposal. We're looking forward to getting started.
      </p>
      ${attachmentNote}
      <p style="color:#313131;font-size:14px;">
        A deposit invoice will follow separately once it's been reviewed on our end.
      </p>
      <p style="color:#313131;font-size:14px;">Thank you,<br/>RESLU</p>
      <p style="color:#A08C72;font-size:11px;margin-top:24px;">219 Sturt Street, Adelaide · reslu.com.au</p>
    </div>
  `.trim();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
