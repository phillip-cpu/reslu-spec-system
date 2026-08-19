import { createServiceRoleClient } from "@/lib/supabase/server";
import { ASSET_BUCKET, slugFilename } from "@/lib/storage";
import type { FinanceRecurringCategory } from "@/types/finance";

type JsonRecord = Record<string, unknown>;

const ACCOUNTS_MAILBOX = "accounts@reslu.com.au";
const INVOICE_FILE = /\.(pdf|png|jpe?g)$/i;
const STATEMENT_WORD = /\b(statement|account summary|aged payables?)\b/i;
const VALID_CATEGORIES = new Set<FinanceRecurringCategory>([
  "wages", "superannuation", "rent", "marketing", "entertainment",
  "software", "insurance", "utilities", "professional_fees", "vehicles", "other",
]);

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function number(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedCurrency(value: unknown): string | null {
  const currency = text(value).toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : null;
}

function sameText(left: string | null | undefined, right: string): boolean {
  return (left ?? "").trim().toLocaleLowerCase("en-AU") === right.trim().toLocaleLowerCase("en-AU");
}

export interface StageCompanyExpenseInvoiceInput {
  emailId: string;
  category: FinanceRecurringCategory;
  recurringCommitmentId?: string | null;
  humanConfirmed: boolean;
}

export async function stageCompanyExpenseInvoice(input: StageCompanyExpenseInvoiceInput) {
  if (input.humanConfirmed !== true) {
    throw new Error("Explicit human confirmation of the company-expense classification is required");
  }
  if (!VALID_CATEGORIES.has(input.category)) throw new Error("Unsupported company expense category");

  const service = createServiceRoleClient();
  const { data: email, error } = await service.from("emails")
    .select("id,subject,ingested_mailboxes,extraction,email_attachments(id,filename,mime,storage_ref,content_sha256)")
    .eq("id", input.emailId).single();
  if (error || !email) throw new Error(error?.message ?? "Accounts email not found");
  if (!(email.ingested_mailboxes ?? []).map((value: string) => value.toLowerCase()).includes(ACCOUNTS_MAILBOX)) {
    throw new Error("Company expense invoices must come from the Accounts mailbox");
  }

  const candidate = (email.extraction as JsonRecord | null)?.supplier_invoice as JsonRecord | null;
  const supplier = text(candidate?.supplier);
  const invoiceNumber = text(candidate?.invoice_number);
  const invoiceDate = text(candidate?.invoice_date);
  const amountExGst = number(candidate?.amount_ex_gst);
  const gst = number(candidate?.gst);
  const total = number(candidate?.total);
  const currencyCode = normalizedCurrency(candidate?.currency);
  const attachments = (email.email_attachments ?? []) as Array<{
    id: string; filename: string | null; mime: string | null;
    storage_ref: string | null; content_sha256: string | null;
  }>;
  const sourceFiles = attachments.filter((attachment) =>
    attachment.storage_ref && INVOICE_FILE.test(attachment.filename ?? "")
  );
  if (STATEMENT_WORD.test(`${email.subject ?? ""} ${sourceFiles.map((item) => item.filename).join(" ")}`)) {
    throw new Error("Supplier statements are reconciliation evidence and cannot be staged as company bills");
  }
  if (!supplier || !invoiceNumber || !/^\d{4}-\d{2}-\d{2}$/.test(invoiceDate)
    || amountExGst === null || total === null || sourceFiles.length !== 1) {
    throw new Error("Invoice fields or the original attachment are incomplete or ambiguous");
  }

  const { data: existingRows } = await service.from("invoices")
    .select("id,expense_scope,company_expense_category,recurring_commitment_id,currency_code")
    .eq("source_email_id", input.emailId)
    .not("status", "in", "(rejected,voided)")
    .order("created_at", { ascending: true }).limit(1);
  if (existingRows?.[0]) {
    if (existingRows[0].expense_scope !== "company") {
      throw new Error("This source email already has a live project invoice");
    }
    return { invoice: existingRows[0], already_staged: true };
  }

  let recurringCommitmentId = input.recurringCommitmentId ?? null;
  if (recurringCommitmentId) {
    const { data: commitment } = await service.from("finance_recurring_commitments")
      .select("id,category,supplier_or_payee,status")
      .eq("id", recurringCommitmentId).single();
    if (!commitment || commitment.status === "archived") throw new Error("Recurring commitment is unavailable");
    if (commitment.category !== input.category) throw new Error("Recurring commitment category does not match the company bill");
    if (commitment.supplier_or_payee && !sameText(commitment.supplier_or_payee, supplier)) {
      throw new Error("Recurring commitment supplier does not match the invoice supplier");
    }
  } else {
    const { data: candidates } = await service.from("finance_recurring_commitments")
      .select("id,supplier_or_payee")
      .eq("category", input.category).neq("status", "archived").limit(25);
    const exactMatches = (candidates ?? []).filter((item) => sameText(item.supplier_or_payee, supplier));
    if (exactMatches.length === 1) recurringCommitmentId = exactMatches[0].id;
  }

  const { data: profile } = await service.from("profiles").select("id").eq("email", ACCOUNTS_MAILBOX).single();
  if (!profile) throw new Error("Stuart profile was not found");
  const source = sourceFiles[0];
  const { data: blob, error: downloadError } = await service.storage.from(ASSET_BUCKET).download(source.storage_ref!);
  if (downloadError || !blob) throw new Error("Original invoice attachment could not be loaded");
  const storagePath = `company/invoices/stuart-${input.emailId}-${slugFilename(source.filename ?? "invoice.pdf")}`;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const { error: uploadError } = await service.storage.from(ASSET_BUCKET)
    .upload(storagePath, bytes, { contentType: source.mime ?? blob.type ?? "application/pdf", upsert: false });
  if (uploadError && !/already exists/i.test(uploadError.message)) throw new Error(uploadError.message);

  const { data: invoice, error: insertError } = await service.from("invoices").insert({
    project_id: null,
    expense_scope: "company",
    company_expense_category: input.category,
    recurring_commitment_id: recurringCommitmentId,
    currency_code: currencyCode,
    supplier,
    invoice_number: invoiceNumber,
    invoice_date: invoiceDate,
    amount_ex_gst: amountExGst,
    gst: gst ?? Math.round((total - amountExGst) * 100) / 100,
    total,
    storage_path: storagePath,
    status: "unmatched",
    created_by: profile.id,
    source: "stuart",
    source_email_id: input.emailId,
    extracted: { ...candidate, company_expense: true, attachment_sha256: source.content_sha256 },
    confidence_note: currencyCode
      ? `Company expense confirmed by a human; source currency ${currencyCode}. Xero creation remains DRAFT-only.`
      : "Company expense confirmed by a human; currency unresolved. Xero draft creation is blocked.",
  }).select("id,expense_scope,company_expense_category,recurring_commitment_id,currency_code").single();
  if (insertError || !invoice) throw new Error(insertError?.message ?? "Company invoice could not be staged in Spec");

  return {
    invoice,
    already_staged: false,
    xero_draft_allowed: currencyCode === "AUD",
    next_step: currencyCode === "AUD"
      ? "Confirm the Xero account mapping before creating a DRAFT bill."
      : "Verify the source currency; non-AUD Xero draft creation remains blocked.",
  };
}
