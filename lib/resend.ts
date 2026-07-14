// ============================================================
// RESLU Spec System — Resend transport core.
//
// Extracted from lib/visit-emails.ts's own sendViaResend()/
// isResendConfigured() (Site-visit lifecycle emails round) so the
// Client invoicing round (BUILD-SPEC.md "Phillip's ideas list — 6 July
// 2026" item 5: "emailed via existing pipeline") can reuse the exact
// same plain-fetch-no-SDK transport with its own `from`/reply-to
// address AND PDF attachments — a capability the visit-emails send
// never needed. Confirmed via a full-repo grep before this extraction:
// nothing outside lib/visit-emails.ts itself ever imported
// sendViaResend/isResendConfigured from "@/lib/visit-emails", so
// lib/visit-emails.ts now delegates to this module internally (see its
// own thin wrapper) with its exact same exported function
// signatures/behaviour unchanged for any future importer of that file.
//
// Generic here (from/replyTo/attachments are caller-supplied, not
// hardcoded) — each feature keeps its OWN sender identity:
//   - lib/visit-emails.ts: "Aria — RESLU <aria@reslu.com.au>" (lead
//     flow round, migration 048 — supersedes that module's original
//     "Phillip — RESLU <visits@reslu.com.au>" identity; see
//     lib/visit-emails.ts's own RESEND_FROM doc comment)
//   - lib/client-invoices-send.ts (this round): "RESLU <accounts@reslu.com.au>"
// ============================================================

export interface ResendSendResult {
  skipped: boolean;
  reason?: string;
  /** Resend's durable email id. Stored on email_sends so signed
   * delivery/open/bounce webhooks can be attached to the exact send. */
  providerMessageId?: string;
}

/** Resend's attachment shape: base64-encoded file content + filename.
 * https://resend.com/docs/api-reference/emails/send-email#attachments */
export interface ResendAttachment {
  filename: string;
  content: string; // base64, no data: URI prefix
}

export interface SendViaResendInput {
  from: string;
  to: string[];
  replyTo: string;
  subject: string;
  html: string;
  attachments?: ResendAttachment[];
}

export function isResendConfigured(): boolean {
  return !!process.env.RESEND_API_KEY;
}

/**
 * Sends one HTML email (optionally with attachments) via Resend's REST
 * API. No-op ({ skipped: true, reason: 'no RESEND_API_KEY' }) when the
 * key isn't configured — every caller's own orchestration layer
 * (lib/visit-emails.ts's sendOrQueue, or the client-invoices send
 * route) is responsible for logging that no-op appropriately (e.g. an
 * email_sends 'skipped' row) rather than this function doing it, since
 * different features log to different shapes. Real send failures (bad
 * key, Resend API error, payload too large) DO throw — callers must not
 * mark anything 'sent' on a failed call.
 *
 * 15s timeout (up from visit-emails' original 10s) — a base64 PDF
 * attachment payload is larger and can legitimately take a little
 * longer to upload than a plain HTML send.
 */
export async function sendViaResend({
  from,
  to,
  replyTo,
  subject,
  html,
  attachments,
}: SendViaResendInput): Promise<ResendSendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { skipped: true, reason: "no RESEND_API_KEY" };
  if (to.length === 0) return { skipped: true, reason: "No recipients" };

  const body: Record<string, unknown> = {
    from,
    to,
    reply_to: replyTo,
    subject,
    html,
  };
  if (attachments && attachments.length > 0) {
    body.attachments = attachments;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Resend send failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const responseBody = (await res.json().catch(() => ({}))) as { id?: unknown };
  return {
    skipped: false,
    ...(typeof responseBody.id === "string" ? { providerMessageId: responseBody.id } : {}),
  };
}
