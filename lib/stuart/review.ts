import { isLikelySupplierInvoice } from "../invoice-candidates.ts";

export type StuartFindingKind =
  | "overdue_receivable"
  | "overdue_payable"
  | "due_soon_receivable"
  | "due_soon_payable"
  | "missing_from_xero"
  | "missing_source_evidence"
  | "xero_conflict"
  | "unmatched_accounts_email"
  | "cost_change"
  | "forecast_risk";

export interface StuartFinding {
  finding_key: string;
  kind: StuartFindingKind;
  severity: "info" | "warning" | "urgent";
  title: string;
  detail: string;
  source_type: string;
  source_id: string | null;
  evidence: Record<string, unknown>;
  confidence: "low" | "medium" | "high";
  last_seen_at: string;
}

export interface StuartAriaFeedback {
  source_email_id: string;
  reason: string;
  corrected_route: string;
  training_rule: string;
}

export interface XeroInvoiceReviewRow {
  xero_invoice_id: string;
  invoice_type: "ACCREC" | "ACCPAY";
  status: string;
  invoice_number: string | null;
  contact_name: string | null;
  due_date: string | null;
  total: number | string | null;
  amount_due: number | string | null;
}

export interface SpecInvoiceReviewRow {
  id: string;
  invoice_number: string;
  supplier?: string | null;
  client_name?: string | null;
  total?: number | string | null;
  total_inc_gst?: number | string | null;
  status: string;
  source_email_id?: string | null;
  storage_path?: string | null;
}

export interface AccountsEmailReviewRow {
  id: string;
  from_addr: string;
  subject: string | null;
  clean_text: string | null;
  received_at: string;
  triage_label: string | null;
  ingested_mailboxes: string[];
  email_attachments?: Array<{
    filename: string | null;
    extracted_text: string | null;
  }>;
}

const FINANCE_RELEVANCE = /\b(invoice|tax invoice|bill|receipt|credit note|remittance|payment|paid|overdue|statement|quote|purchase order|cost|price|pricing|rate|gst|bas|refund|bank)\b/i;
const COST_CHANGE = /\b(price|pricing|rate|cost)\b.{0,45}\b(increase|decrease|change|new|revised|effective|rise|adjust)/i;

function canonical(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "").replace(/^0+/, "");
}

function money(value: number | string | null | undefined): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : null;
}

function daysBetween(from: string, to: string): number {
  return Math.floor((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

function invoiceDirectionLabel(type: "ACCREC" | "ACCPAY") {
  return type === "ACCREC" ? "customer invoice" : "supplier bill";
}

export function reviewXeroInvoices(rows: XeroInvoiceReviewRow[], today: string, now: string): StuartFinding[] {
  const findings: StuartFinding[] = [];
  for (const row of rows) {
    const amountDue = money(row.amount_due);
    if (!row.due_date || amountDue == null || amountDue <= 0 || /^(paid|voided|deleted)$/i.test(row.status)) continue;
    const days = daysBetween(today, row.due_date);
    const receivable = row.invoice_type === "ACCREC";
    if (days < 0) {
      findings.push({
        finding_key: `xero:${row.xero_invoice_id}:overdue`,
        kind: receivable ? "overdue_receivable" : "overdue_payable",
        severity: days <= -30 || amountDue >= 10_000 ? "urgent" : "warning",
        title: `${receivable ? "Customer invoice" : "Supplier bill"} ${row.invoice_number ?? "without a number"} is overdue`,
        detail: `${row.contact_name ?? "Unknown contact"} has ${amountDue.toFixed(2)} outstanding, due ${row.due_date}.`,
        source_type: "xero_invoice",
        source_id: row.xero_invoice_id,
        evidence: { invoice_number: row.invoice_number, contact_name: row.contact_name, due_date: row.due_date, amount_due: amountDue, days_overdue: Math.abs(days), direction: row.invoice_type },
        confidence: "high",
        last_seen_at: now,
      });
    } else if (days <= 7) {
      findings.push({
        finding_key: `xero:${row.xero_invoice_id}:due-soon`,
        kind: receivable ? "due_soon_receivable" : "due_soon_payable",
        severity: "info",
        title: `${receivable ? "Customer invoice" : "Supplier bill"} ${row.invoice_number ?? "without a number"} is due soon`,
        detail: `${row.contact_name ?? "Unknown contact"} has ${amountDue.toFixed(2)} due ${row.due_date}.`,
        source_type: "xero_invoice",
        source_id: row.xero_invoice_id,
        evidence: { invoice_number: row.invoice_number, contact_name: row.contact_name, due_date: row.due_date, amount_due: amountDue, days_until_due: days, direction: row.invoice_type },
        confidence: "high",
        last_seen_at: now,
      });
    }
  }
  return findings;
}

export function reviewSpecAgainstXero(
  specRows: SpecInvoiceReviewRow[],
  xeroRows: XeroInvoiceReviewRow[],
  direction: "ACCREC" | "ACCPAY",
  now: string
): StuartFinding[] {
  const candidates = xeroRows.filter((row) => row.invoice_type === direction);
  return specRows.flatMap<StuartFinding>((spec): StuartFinding[] => {
    if (/^(void|rejected|draft)$/i.test(spec.status)) return [];
    const number = canonical(spec.invoice_number);
    const exactNumber = candidates.filter((row) => canonical(row.invoice_number) === number);
    if (exactNumber.length === 0) {
      if (direction === "ACCPAY" && (!spec.source_email_id || !spec.storage_path)) {
        return [{
          finding_key: `spec:${direction}:${spec.id}:missing-source-evidence`,
          kind: "missing_source_evidence" as const,
          severity: "warning" as const,
          title: `Supplier bill candidate ${spec.invoice_number} lacks source evidence`,
          detail: "Spec has no traceable source email and attached original. Do not treat this record as a verified bill missing from Xero; it may be a quote, duplicate or incomplete legacy entry.",
          source_type: "supplier_invoice",
          source_id: spec.id,
          evidence: {
            invoice_number: spec.invoice_number,
            status: spec.status,
            direction,
            source_email_present: Boolean(spec.source_email_id),
            source_document_present: Boolean(spec.storage_path),
          },
          confidence: "high" as const,
          last_seen_at: now,
        }];
      }
      return [{
        finding_key: `spec:${direction}:${spec.id}:missing-xero`,
        kind: "missing_from_xero" as const,
        severity: "warning" as const,
        title: `${invoiceDirectionLabel(direction)} ${spec.invoice_number} is missing from Xero`,
        detail: "The invoice exists in Spec but no Xero invoice with the same normalised number was found.",
        source_type: direction === "ACCREC" ? "client_invoice" : "supplier_invoice",
        source_id: spec.id,
        evidence: { invoice_number: spec.invoice_number, status: spec.status, direction },
        confidence: "high" as const,
        last_seen_at: now,
      }];
    }
    const specTotal = money(spec.total ?? spec.total_inc_gst);
    const matched = exactNumber[0];
    const xeroTotal = money(matched.total);
    if (specTotal != null && xeroTotal != null && Math.abs(specTotal - xeroTotal) >= 0.01) {
      return [{
        finding_key: `spec:${direction}:${spec.id}:total-conflict`,
        kind: "xero_conflict" as const,
        severity: "urgent" as const,
        title: `${invoiceDirectionLabel(direction)} ${spec.invoice_number} differs from Xero`,
        detail: `Spec records ${specTotal.toFixed(2)} while Xero records ${xeroTotal.toFixed(2)}.`,
        source_type: direction === "ACCREC" ? "client_invoice" : "supplier_invoice",
        source_id: spec.id,
        evidence: { invoice_number: spec.invoice_number, spec_total: specTotal, xero_total: xeroTotal, xero_invoice_id: matched.xero_invoice_id, direction },
        confidence: "high" as const,
        last_seen_at: now,
      }];
    }
    return [];
  });
}

export function reviewAccountsEmails(
  emails: AccountsEmailReviewRow[],
  linkedEmailIds: Set<string>,
  now: string
): { findings: StuartFinding[]; feedback: StuartAriaFeedback[] } {
  const findings: StuartFinding[] = [];
  const feedback: StuartAriaFeedback[] = [];
  for (const email of emails) {
    const attachmentNames = email.email_attachments?.map((item) => item.filename ?? "") ?? [];
    const attachmentTexts = email.email_attachments?.map((item) => item.extracted_text ?? "") ?? [];
    const combined = [email.subject, email.clean_text, ...attachmentTexts].filter(Boolean).join("\n");
    const likelyInvoice = isLikelySupplierInvoice({ subject: email.subject, clean_text: email.clean_text, attachment_filenames: attachmentNames, attachment_texts: attachmentTexts });
    const relevant = likelyInvoice || FINANCE_RELEVANCE.test(combined);
    if (likelyInvoice && !linkedEmailIds.has(email.id)) {
      findings.push({
        finding_key: `email:${email.id}:unmatched-invoice`,
        kind: "unmatched_accounts_email",
        severity: "warning",
        title: "Accounts email contains an invoice that has not been linked",
        detail: email.subject?.trim() || "Invoice-like email requires review.",
        source_type: "email",
        source_id: email.id,
        evidence: { subject: email.subject, from_addr: email.from_addr, received_at: email.received_at, attachment_filenames: attachmentNames },
        confidence: "medium",
        last_seen_at: now,
      });
    }
    if (COST_CHANGE.test(combined)) {
      findings.push({
        finding_key: `email:${email.id}:cost-change`,
        kind: "cost_change",
        severity: "info",
        title: "Possible supplier cost or rate change",
        detail: email.subject?.trim() || "Supplier correspondence may change future job costs.",
        source_type: "email",
        source_id: email.id,
        evidence: { subject: email.subject, from_addr: email.from_addr, received_at: email.received_at, attachment_filenames: attachmentNames },
        confidence: "medium",
        last_seen_at: now,
      });
    }
    if (email.from_addr.trim().toLowerCase() === "aria@reslu.com.au" && !relevant) {
      feedback.push({
        source_email_id: email.id,
        reason: "This message has no invoice, receipt, statement, payment issue, cost update or other financial evidence.",
        corrected_route: "General correspondence or junk; do not send it to Accounts.",
        training_rule: "Only forward to Accounts when the message contains a bill, invoice, receipt, credit note, remittance, statement, payment issue, tax item or material supplier cost change.",
      });
    }
  }
  return { findings, feedback };
}
