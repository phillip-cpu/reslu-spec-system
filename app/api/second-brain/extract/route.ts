import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import {
  invoiceCandidateAttachmentHashes,
  invoiceCandidateDedupeKey,
  isUsableSupplierInvoiceCandidate,
} from "@/lib/invoice-candidates";
import { prepareCompanyOverheadIntake } from "@/lib/finance/company-overhead-intake";
import { extractEmail, type ExtractionAttachment } from "@/lib/second-brain/extraction";

export const runtime = "nodejs";

const BATCH_SIZE = 10;

/**
 * GET /api/second-brain/extract — Vercel Cron entry point.
 *
 * RESLU Second Brain, Step 9 (docs/RESLU-second-brain-build-brief.md).
 * Picks up status='triaged' emails (actionable only — fyi/noise never
 * reach this status, see the triage route) and runs one Sonnet
 * extraction per email via lib/second-brain/extraction.ts, including
 * a vision pass for any needs_vision=true attachments. Writes
 * emails.extraction (migration 038) and, for any vision attachment
 * processed, email_attachments.extracted_text (its transcription —
 * see extraction.ts's header for why this matters for Step 11's
 * verification gate).
 *
 * Per-email try/catch: one bad email must not block the batch,
 * matching app/api/trade-reminders/route.ts's established resilience
 * pattern. A failure leaves status='triaged' so the next cron run
 * retries it, rather than silently losing the email.
 *
 * Auth mirrors every other cron in this build: Bearer CRON_SECRET or
 * an authenticated team session.
 */
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");
  const isCronCall = !!cronSecret && authHeader === `Bearer ${cronSecret}`;

  if (!isCronCall) {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const supabase = createServiceRoleClient();

  const { data: emails, error } = await supabase
    .from("emails")
    .select("id,from_addr,subject,clean_text,triage_label,matched_project_id,ingested_mailboxes")
    .eq("status", "triaged")
    .order("received_at", { ascending: true })
    .limit(BATCH_SIZE);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (!emails || emails.length === 0) {
    return NextResponse.json({ extracted: 0, failed: 0 });
  }

  let extracted = 0;
  let failed = 0;

  for (const email of emails) {
    try {
      const { data: attachments, error: attError } = await supabase
        .from("email_attachments")
        .select("id,filename,mime,storage_ref,extracted_text,extraction_method,needs_vision,kept_pages,content_sha256")
        .eq("email_id", email.id);
      if (attError) throw new Error(`attachment fetch failed: ${attError.message}`);

      const { result, xeroUrl } = await extractEmail(supabase, email, (attachments ?? []) as ExtractionAttachment[]);

      const isAccountsInvoice = (email.ingested_mailboxes ?? [])
        .map((mailbox: string) => mailbox.toLowerCase())
        .includes("accounts@reslu.com.au");
      if (isUsableSupplierInvoiceCandidate(result.supplier_invoice) && !isAccountsInvoice) {
        const sourceAttachment = (attachments ?? []).find((attachment) =>
          attachment.mime?.toLowerCase() === "application/pdf" ||
          attachment.filename?.toLowerCase().endsWith(".pdf")
        );
        const overheadDecision = sourceAttachment
          ? prepareCompanyOverheadIntake({
              source_email_id: email.id,
              source_attachment_id: sourceAttachment.id,
              ingested_mailboxes: email.ingested_mailboxes ?? [],
              triage_label: email.triage_label,
              matched_project_id: email.matched_project_id,
              supplier: result.supplier_invoice?.supplier,
              invoice_date: result.supplier_invoice?.invoice_date,
              amount_ex_gst: result.supplier_invoice?.amount_ex_gst,
              gst: result.supplier_invoice?.gst,
              total: result.supplier_invoice?.total,
              currency_code: result.supplier_invoice?.currency_code,
              job_hints: result.supplier_invoice?.job_hints,
              job_mentions: result.job_mentions?.map((mention) => mention.text) ?? [],
              subject: email.subject,
              line_hints: result.supplier_invoice?.line_hints,
              attachment_filename: sourceAttachment.filename,
              attachment_mime: sourceAttachment.mime,
            })
          : null;
        const overheadIntake = overheadDecision?.eligible ? overheadDecision.intake : null;
        const { error: queueError } = await supabase.from("aria_queue").upsert(
          {
            kind: "invoice_candidate",
            dedupe_key: invoiceCandidateDedupeKey(
              email.id,
              invoiceCandidateAttachmentHashes(attachments ?? [])
            ),
            source: "second-brain-extraction",
            payload: {
              action: overheadIntake
                ? "prepare_company_overhead_finance_intake_approval"
                : "review_supplier_invoice",
              source_email_id: email.id,
              from_addr: email.from_addr,
              subject: email.subject,
              candidate: result.supplier_invoice,
              company_overhead_intake: overheadIntake,
              xero_url: xeroUrl ?? null,
              instruction: overheadIntake
                ? "This source-backed supplier invoice has no explicit project evidence. Treat RESLU, RESLU Developments and RESLU Studio as company identity/address hints, not job proof. Create a bounded durable Aria task whose visible draft artifact routes the source to accounts@reslu.com.au and includes an authority_request for commit_company_overhead_finance_intake with company_overhead_intake as the exact tool_args. The task must remain awaiting_approval until Phillip approves the exact artifact. Do not create a Spec project invoice, Cockpit row, Xero bill or email send before that approval. The approved commit creates a one-time Cockpit draft and an internal accounts-routing result; it does not send email."
                : "Match this invoice candidate to the correct RESLU project and specification context, then call propose_supplier_invoice. A delivery, billing or company address alone, including RESLU Studio or RESLU Developments, is not proof of the cost project. If reliable project evidence is absent but the deterministic company-overhead packet is incomplete, request the missing evidence instead of assigning a project. Do not approve, apply, mark paid, or alter project financials.",
            },
          },
          { onConflict: "dedupe_key", ignoreDuplicates: true }
        );
        if (queueError) throw new Error(`invoice review queue failed: ${queueError.message}`);
      }

      const { error: updateError } = await supabase
        .from("emails")
        .update({ extraction: result, status: "extracted", processed_at: new Date().toISOString() })
        .eq("id", email.id);
      if (updateError) throw new Error(`email update failed: ${updateError.message}`);

      for (const transcription of result.attachment_transcriptions) {
        const { error: transcriptionError } = await supabase
          .from("email_attachments")
          .update({ extracted_text: transcription.text, extraction_method: "vision" })
          .eq("id", transcription.attachment_id);
        if (transcriptionError) {
          console.error("extract: attachment transcription write failed", transcription.attachment_id, transcriptionError.message);
        }
      }

      extracted++;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown extraction error";
      console.error("second-brain/extract: failed for email", email.id, message);
      failed++;
    }
  }

  return NextResponse.json({ extracted, failed, batch_size: emails.length });
}
