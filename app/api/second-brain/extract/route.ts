import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import {
  invoiceCandidateAttachmentHashes,
  invoiceCandidateDedupeKey,
} from "@/lib/invoice-candidates";
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
    .select("id,from_addr,subject,clean_text")
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
        .select("id,filename,mime,storage_ref,needs_vision,kept_pages,content_sha256")
        .eq("email_id", email.id);
      if (attError) throw new Error(`attachment fetch failed: ${attError.message}`);

      const { result, xeroUrl } = await extractEmail(supabase, email, (attachments ?? []) as ExtractionAttachment[]);

      if (result.supplier_invoice) {
        const { error: queueError } = await supabase.from("aria_queue").upsert(
          {
            kind: "invoice_candidate",
            dedupe_key: invoiceCandidateDedupeKey(
              email.id,
              invoiceCandidateAttachmentHashes(attachments ?? [])
            ),
            source: "second-brain-extraction",
            payload: {
              action: "review_supplier_invoice",
              source_email_id: email.id,
              from_addr: email.from_addr,
              subject: email.subject,
              candidate: result.supplier_invoice,
              xero_url: xeroUrl ?? null,
              instruction:
                "Match this invoice candidate to the correct RESLU project and specification context, then call propose_supplier_invoice. Do not approve, apply, mark paid, or alter project financials.",
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
