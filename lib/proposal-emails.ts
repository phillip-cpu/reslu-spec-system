// ============================================================
// RESLU Spec System — Fee proposal phase (r23) — the "send" email.
//
// This round's own build boundary marks lib/visit-emails.ts as
// "read-don't-edit" (it is the invoicing/trade-booking/lead-flow send
// pipeline's own file, out of this round's edit list) — so this module
// does NOT add a 'proposal' member to that file's internal
// VisitEmailRecordType/TEMPLATE_FILES maps (both private to that
// module's own closure/types). Instead it REUSES, unmodified, the
// generic pieces that module already exports for exactly this purpose:
//   - merge() — the plain {{placeholder}} replacer. Its `values` map is
//     fixed to a known set of keys (first_name, company, project_name,
//     project_address, request_link, attachments_note, phillip_phone,
//     etc.) — emails/proposal-sent.html is written to use ONLY that
//     existing key set (see that file's own header comment), so merge()
//     works here with zero changes.
//   - sendViaResend() — this module's own thin wrapper, already sending
//     from 'Aria — RESLU <aria@reslu.com.au>' (the exact sender BUILD-
//     SPEC.md item 3 asks for: "Aria sender").
//   - isWithinSendWindow() / nextAdelaide7am() — the 7am-7pm Adelaide
//     send-window gate, reused so a proposal email obeys the same
//     "never send outside business hours" rule as every other
//     client-facing send in this codebase.
//
// The template-file read/cache and the email_sends guard/log are
// re-implemented locally (a few lines each) rather than importing
// lib/visit-emails.ts's own loadTemplate()/sendOrQueue() — both of
// those are keyed by that module's own closed VisitEmailTemplateName/
// VisitEmailRecordType unions ('proposal-sent' and 'proposal' are not,
// and cannot become, members of either without editing that file).
// Same "small, deliberate duplication between independent pipelines"
// precedent as components/pdf/InvoicePdf.tsx/SowPdf.tsx's own font
// registration (see either file's header comment).
// ============================================================

import { readFile } from "fs/promises";
import path from "path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { reportError } from "@/lib/report-error";
import {
  merge,
  isWithinSendWindow,
  nextAdelaide7am,
  sendViaResend,
  type VisitEmailMergeData,
} from "@/lib/visit-emails";

const TEMPLATE_PATH = path.join(process.cwd(), "emails", "proposal-sent.html");
let templateCache: string | null = null;

async function loadProposalSentTemplate(): Promise<string> {
  if (templateCache !== null) return templateCache;
  const html = await readFile(TEMPLATE_PATH, "utf8");
  templateCache = html;
  return html;
}

export interface SendProposalEmailInput {
  proposalId: string;
  to: string[];
  subject: string;
  /** Reuses lib/visit-emails.ts's own generic merge-data shape — see this file's header comment for which keys emails/proposal-sent.html actually uses (company/project_name/project_address/request_link/attachments_note/phillip_phone). */
  mergeData: VisitEmailMergeData;
  now?: Date;
}

export type SendProposalEmailAction = "sent" | "queued" | "skipped";

export interface SendProposalEmailResult {
  action: SendProposalEmailAction;
  reason?: string;
}

/**
 * Sends (or queues, outside the 7am-7pm Adelaide window) the
 * 'proposal-sent' email and logs one email_sends row
 * (record_type='proposal', template='proposal-sent' — the CHECK
 * constraint on record_type is widened to allow 'proposal' by
 * migration 051; template itself has never been a CHECK-constrained
 * column, see 043_visit_emails.sql's own comment). Called by BOTH POST
 * /api/proposals/[id]/send (first send) and POST
 * /api/proposals/[id]/resend (follow-up resend, same token/link) — the
 * dupe-guard for a resend is the CALLER's responsibility (a simple
 * "was the last email_sends row for this proposal sent within the last
 * couple of minutes" check — see the resend route's own doc comment),
 * not this function's, since a legitimate resend is EXPECTED to
 * produce a second 'sent' row.
 */
export async function sendProposalEmail(
  supabase: SupabaseClient,
  input: SendProposalEmailInput
): Promise<SendProposalEmailResult> {
  const { proposalId, to, subject, mergeData } = input;
  const now = input.now ?? new Date();

  if (to.length === 0) {
    return { action: "skipped", reason: "No recipient email on file" };
  }

  let html: string;
  try {
    html = merge(await loadProposalSentTemplate(), mergeData);
  } catch (err) {
    await reportError("proposal-emails", err);
    await supabase.from("email_sends").insert({
      record_type: "proposal",
      record_id: proposalId,
      template: "proposal-sent",
      to_email: to.join(", "),
      status: "skipped",
      detail: { subject, reason: "Template file missing or unreadable" },
    });
    return { action: "skipped", reason: "Template load failed" };
  }

  if (!isWithinSendWindow(now)) {
    await supabase.from("email_sends").insert({
      record_type: "proposal",
      record_id: proposalId,
      template: "proposal-sent",
      to_email: to.join(", "),
      status: "pending",
      scheduled_for: nextAdelaide7am(now).toISOString(),
      detail: { ...mergeData, subject },
    });
    return { action: "queued", reason: "Outside 7am-7pm Adelaide window" };
  }

  try {
    const result = await sendViaResend({ to, subject, html });
    if (result.skipped) {
      await supabase.from("email_sends").insert({
        record_type: "proposal",
        record_id: proposalId,
        template: "proposal-sent",
        to_email: to.join(", "),
        status: "skipped",
        detail: { ...mergeData, subject, reason: result.reason },
      });
      return { action: "skipped", reason: result.reason };
    }
    await supabase.from("email_sends").insert({
      record_type: "proposal",
      record_id: proposalId,
      template: "proposal-sent",
      to_email: to.join(", "),
      status: "sent",
      sent_at: now.toISOString(),
      detail: { ...mergeData, subject },
    });
    return { action: "sent" };
  } catch (err) {
    await reportError("proposal-emails", err);
    await supabase.from("email_sends").insert({
      record_type: "proposal",
      record_id: proposalId,
      template: "proposal-sent",
      to_email: to.join(", "),
      status: "pending",
      scheduled_for: now.toISOString(),
      detail: { ...mergeData, subject, reason: "Send failed, queued for retry" },
    });
    return { action: "queued", reason: "Send failed, queued for retry" };
  }
}

/** Most recent email_sends row for this proposal's 'proposal-sent' template — used by both the resend route's dupe guard and the Builder UI's status chip. */
export async function latestProposalSentRow(
  supabase: SupabaseClient,
  proposalId: string
): Promise<{ id: string; status: string; sent_at: string | null; created_at: string } | null> {
  const { data } = await supabase
    .from("email_sends")
    .select("id,status,sent_at,created_at")
    .eq("record_type", "proposal")
    .eq("record_id", proposalId)
    .eq("template", "proposal-sent")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}
