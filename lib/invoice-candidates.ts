const INVOICE_WORD = /\b(invoice|tax invoice|credit note|remittance)\b/i;
const INVOICE_NUMBER = /\b(?:invoice|inv|credit note)\s*(?:no\.?|number|#)?\s*[:#-]?\s*[a-z0-9][a-z0-9/-]{2,}\b/i;
const MONEY = /(?:\ba\$|\baud|\$)\s?\d[\d,]*(?:\.\d{2})?/i;
const INVOICE_FILENAME = /(?:invoice|tax[-_ ]?invoice|credit[-_ ]?note).*(?:\.pdf|\.png|\.jpe?g)$/i;

export interface InvoiceCandidateEvidence {
  subject?: string | null;
  clean_text?: string | null;
  attachment_filenames?: string[];
  attachment_texts?: string[];
}

/**
 * Conservative, zero-model invoice detector used to wake Aria. It only
 * creates a review item; it never creates or approves a financial row.
 */
export function isLikelySupplierInvoice(input: InvoiceCandidateEvidence): boolean {
  const filenames = input.attachment_filenames ?? [];
  if (filenames.some((name) => INVOICE_FILENAME.test(name))) return true;

  const text = [
    input.subject,
    input.clean_text,
    ...(input.attachment_texts ?? []),
  ]
    .filter(Boolean)
    .join("\n");
  return INVOICE_WORD.test(text) && (INVOICE_NUMBER.test(text) || MONEY.test(text));
}
