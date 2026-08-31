import { createHash } from "node:crypto";

const INTAKE_MAILBOXES = new Set([
  "phillip@reslu.com.au",
  "aria@reslu.com.au",
  "tenille@reslu.com.au",
]);

const COMPANY_ONLY_HINTS = new Set([
  "reslu",
  "reslu developments",
  "reslu developments pty ltd",
  "reslu studio",
]);

const CATEGORY_RULES: Array<[RegExp, CompanyOverheadCategory]> = [
  [/\b(account(?:ant|ancy|ing)?|bookkeep|tax|legal|solicitor|consult|professional|audit|financial services|profit and loss|balance sheet)\b/i, "professional_fees"],
  [/\b(electric|electricity|gas|water|internet|telephone|utility|utilities)\b/i, "utilities"],
  [/\b(rent|lease|landlord|property management)\b/i, "rent"],
  [/\b(insurance|premium|policy)\b/i, "insurance"],
  [/\b(software|subscription|licen[cs]e|hosting|saas)\b/i, "software"],
  [/\b(vehicle|motor|fuel|rego|registration)\b/i, "vehicles"],
  [/\b(marketing|advertis|google ads|meta ads)\b/i, "marketing"],
];

export type CompanyOverheadCategory =
  | "rent"
  | "marketing"
  | "software"
  | "insurance"
  | "utilities"
  | "professional_fees"
  | "vehicles"
  | "other";

export interface CompanyOverheadSource {
  source_email_id: string;
  source_attachment_id: string;
  ingested_mailboxes: string[];
  triage_label?: string | null;
  matched_project_id?: string | null;
  supplier?: string | null;
  invoice_date?: string | null;
  amount_ex_gst?: number | null;
  gst?: number | null;
  total?: number | null;
  currency_code?: string | null;
  job_hints?: string | null;
  job_mentions?: string[];
  subject?: string | null;
  line_hints?: string | null;
  attachment_filename?: string | null;
  attachment_mime?: string | null;
}

export interface CompanyOverheadIntake {
  source_email_id: string;
  source_attachment_id: string;
  supplier: string;
  invoice_date: string;
  amount_ex_gst_minor: number;
  gst_minor: number;
  total_minor: number;
  currency_code: "AUD";
  duplicate_key: string;
  category: CompanyOverheadCategory;
  route_to: "accounts@reslu.com.au";
  frequency: "once";
  status: "draft";
  expense_scope: "company";
  project_id: null;
}

export type CompanyOverheadDecision =
  | { eligible: true; intake: CompanyOverheadIntake }
  | { eligible: false; reason: string };

function normalizedHint(value: string): string {
  return value.toLowerCase().replace(/\bpty\.?\s*ltd\.?\b/g, "pty ltd").replace(/[^a-z0-9]+/g, " ").trim();
}

function isCompanyOnlyHint(value: string): boolean {
  const normalized = normalizedHint(value);
  return !normalized || COMPANY_ONLY_HINTS.has(normalized);
}

export function hasExplicitProjectHint(source: Pick<CompanyOverheadSource, "matched_project_id" | "job_hints" | "job_mentions">): boolean {
  if (source.matched_project_id) return true;
  const hints = [source.job_hints, ...(source.job_mentions ?? [])]
    .filter((value): value is string => Boolean(value?.trim()));
  return hints.some((hint) => !isCompanyOnlyHint(hint));
}

function isoDate(value: string): string | null {
  const exact = value.trim().match(/^\d{4}-\d{2}-\d{2}$/)?.[0];
  if (exact && !Number.isNaN(Date.parse(`${exact}T00:00:00Z`))) return exact;
  const ordinal = value.trim().replace(/(\d)(st|nd|rd|th)\b/gi, "$1");
  const words = ordinal.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (words) {
    const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
    const month = months.indexOf(words[2].toLowerCase());
    const day = Number(words[1]);
    if (month >= 0 && day >= 1 && day <= 31) {
      const result = `${words[3]}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      if (!Number.isNaN(Date.parse(`${result}T00:00:00Z`))) return result;
    }
  }
  const parsed = new Date(ordinal);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString().slice(0, 10);
}

function minor(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const result = Math.round(value * 100);
  return Number.isSafeInteger(result) ? result : null;
}

function categoryFor(source: CompanyOverheadSource): CompanyOverheadCategory {
  const evidence = [source.supplier, source.subject, source.line_hints, source.attachment_filename]
    .filter(Boolean)
    .join("\n");
  return CATEGORY_RULES.find(([pattern]) => pattern.test(evidence))?.[1] ?? "other";
}

export function companyOverheadDuplicateKey(supplier: string, invoiceDate: string, totalMinor: number): string {
  const identity = `${normalizedHint(supplier)}|${invoiceDate}|${totalMinor}`;
  return `company-overhead:${createHash("sha256").update(identity, "utf8").digest("hex")}`;
}

/**
 * Deterministic preparation only. This function never writes a Spec, Xero,
 * Cockpit or email record. A consequential tool may consume the returned
 * packet only after Phillip approves its exact task artifact.
 */
export function prepareCompanyOverheadIntake(source: CompanyOverheadSource): CompanyOverheadDecision {
  const mailboxes = source.ingested_mailboxes.map((value) => value.trim().toLowerCase());
  if (!mailboxes.some((mailbox) => INTAKE_MAILBOXES.has(mailbox))) {
    return { eligible: false, reason: "The source was not ingested from Phillip, Aria or Tenille." };
  }
  if (source.triage_label !== "supplier_invoice") {
    return { eligible: false, reason: "The email is not classified as supplier_invoice." };
  }
  if (hasExplicitProjectHint(source)) {
    return { eligible: false, reason: "Explicit project evidence exists; use the project invoice workflow." };
  }
  if (!source.source_attachment_id || !source.attachment_filename || !/pdf/i.test(source.attachment_mime ?? source.attachment_filename)) {
    return { eligible: false, reason: "A source supplier-invoice PDF is required." };
  }
  const supplier = source.supplier?.trim();
  const invoiceDate = source.invoice_date ? isoDate(source.invoice_date) : null;
  const amountExGstMinor = minor(source.amount_ex_gst);
  const gstMinor = minor(source.gst);
  const totalMinor = minor(source.total);
  if (!supplier || !invoiceDate || amountExGstMinor === null || gstMinor === null || totalMinor === null || totalMinor <= 0) {
    return { eligible: false, reason: "Supplier, ISO invoice date, ex-GST, GST and total evidence are required." };
  }
  if (Math.abs(amountExGstMinor + gstMinor - totalMinor) > 1) {
    return { eligible: false, reason: "The source amounts do not reconcile." };
  }
  const currency = (source.currency_code ?? "AUD").trim().toUpperCase();
  if (currency !== "AUD") {
    return { eligible: false, reason: "Foreign-currency invoices require separate human-confirmed currency handling." };
  }
  return {
    eligible: true,
    intake: {
      source_email_id: source.source_email_id,
      source_attachment_id: source.source_attachment_id,
      supplier,
      invoice_date: invoiceDate,
      amount_ex_gst_minor: amountExGstMinor,
      gst_minor: gstMinor,
      total_minor: totalMinor,
      currency_code: "AUD",
      duplicate_key: companyOverheadDuplicateKey(supplier, invoiceDate, totalMinor),
      category: categoryFor(source),
      route_to: "accounts@reslu.com.au",
      frequency: "once",
      status: "draft",
      expense_scope: "company",
      project_id: null,
    },
  };
}
