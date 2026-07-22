const INVOICE_WORD = /\b(invoice|tax invoice|credit note|remittance)\b/i;
const INVOICE_NUMBER = /\b(?:invoice(?!\s+candidates?\b)|inv\b|credit note)\s*(?:no\.?|number|#)?\s*[:#-]?\s*[a-z0-9][a-z0-9/-]{2,}\b/i;
const MONEY = /(?:\ba\$|\baud|\$)\s?\d[\d,]*(?:\.\d{2})?/i;
const INVOICE_FILENAME = /(?:invoice|tax[-_ ]?invoice|credit[-_ ]?note).*(?:\.pdf|\.png|\.jpe?g)$/i;
const INTERNAL_BRIEF_SUBJECT = /^RESLU\s+(?:morning|daily|weekly)\s+brief\b/i;

export interface InvoiceCandidateEvidence {
  subject?: string | null;
  clean_text?: string | null;
  attachment_filenames?: string[];
  attachment_texts?: string[];
}

export interface InvoiceAttachmentFingerprint {
  filename?: string | null;
  mime?: string | null;
  content_sha256?: string | null;
}

export interface ExtractedSupplierInvoiceCandidate {
  supplier?: string | null;
  total?: number | null;
  source_quote?: string | null;
}

/**
 * Conservative, zero-model invoice detector used to wake Aria. It only
 * creates a review item; it never creates or approves a financial row.
 */
export function isLikelySupplierInvoice(input: InvoiceCandidateEvidence): boolean {
  if (INTERNAL_BRIEF_SUBJECT.test(input.subject?.trim() ?? "")) return false;
  const filenames = input.attachment_filenames ?? [];
  if (filenames.some((name) => INVOICE_FILENAME.test(name))) return true;

  const text = [
    input.subject,
    input.clean_text,
    ...(input.attachment_texts ?? []),
  ]
    .filter(Boolean)
    .join("\n");
  return INVOICE_WORD.test(text) && INVOICE_NUMBER.test(text) && MONEY.test(text);
}

/** Reject incomplete model output before it becomes queue work. A zero-value
 * or source-less candidate cannot become a useful supplier invoice proposal
 * and otherwise traps Aria in an unresolvable review loop. */
export function isUsableSupplierInvoiceCandidate(
  candidate: ExtractedSupplierInvoiceCandidate | null | undefined
): boolean {
  return Boolean(
    candidate &&
      candidate.supplier?.trim() &&
      candidate.source_quote?.trim() &&
      typeof candidate.total === "number" &&
      Number.isFinite(candidate.total) &&
      Math.abs(candidate.total) >= 0.01
  );
}

/** Excludes signature logos and other repeated inline assets from financial
 * dedupe. Invoice-named documents win; otherwise a PDF is the conservative
 * fallback for model-detected invoices with generic filenames. */
export function invoiceCandidateAttachmentHashes(
  attachments: InvoiceAttachmentFingerprint[]
): string[] {
  const valid = attachments.filter((attachment) =>
    /^[a-f0-9]{64}$/i.test(attachment.content_sha256?.trim() ?? "")
  );
  const invoiceNamed = valid.filter((attachment) =>
    INVOICE_FILENAME.test(attachment.filename ?? "")
  );
  const selected = invoiceNamed.length
    ? invoiceNamed
    : valid.filter(
        (attachment) =>
          attachment.mime?.toLowerCase() === "application/pdf" ||
          attachment.filename?.toLowerCase().endsWith(".pdf")
      );
  return selected.map((attachment) => attachment.content_sha256!.trim());
}

/**
 * One supplier PDF can arrive directly and later be forwarded between RESLU
 * mailboxes. Keep both emails in the Second Brain, but use the attachment hash
 * as the queue's business key so Aria receives one invoice review task. The
 * existing email-id key remains the fallback for legacy/unhashed attachments.
 */
export function invoiceCandidateDedupeKey(
  emailId: string,
  attachmentHashes: Array<string | null | undefined>
): string {
  const canonicalHash = attachmentHashes
    .map((hash) => hash?.trim().toLowerCase() ?? "")
    .filter((hash) => /^[a-f0-9]{64}$/.test(hash))
    .sort()[0];
  return canonicalHash
    ? `invoice_candidate:attachment:${canonicalHash}`
    : `invoice_candidate:${emailId}`;
}
