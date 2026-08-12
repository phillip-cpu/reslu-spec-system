import { createServiceRoleClient } from "@/lib/supabase/server";
import { ASSET_BUCKET, slugFilename } from "@/lib/storage";
import { createStuartXeroDraftBill } from "@/lib/stuart/xero-draft-bills";
import { inferSingleExpenseAccountCode } from "@/lib/stuart/account-code";

type JsonRecord = Record<string, unknown>;

const ACCOUNTS_MAILBOX = "accounts@reslu.com.au";
const STATEMENT_WORD = /\b(statement|account summary|aged payables?)\b/i;
const INVOICE_FILE = /\.(pdf|png|jpe?g)$/i;

export type AutomationOutcome = "draft_created" | "manual_review" | "already_processed";

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function number(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function recordFinding(emailId: string, title: string, detail: string, evidence: JsonRecord) {
  const service = createServiceRoleClient();
  await service.from("stuart_finance_findings").upsert({
    finding_key: `accounts-invoice:${emailId}`,
    kind: "unmatched_accounts_email",
    severity: "warning",
    status: "open",
    title,
    detail,
    source_type: "supplier_invoice",
    source_id: emailId,
    evidence,
    confidence: "high",
    last_seen_at: new Date().toISOString(),
    resolved_at: null,
  }, { onConflict: "finding_key" });
}

export async function processAccountsInvoice(emailId: string): Promise<{ outcome: AutomationOutcome; invoice_id?: string; xero_invoice_id?: string; reason?: string }> {
  const service = createServiceRoleClient();
  const { data: email, error } = await service.from("emails")
    .select("id,subject,ingested_mailboxes,extraction,email_attachments(id,filename,mime,storage_ref,content_sha256)")
    .eq("id", emailId).single();
  if (error || !email) throw new Error(error?.message ?? "Accounts email not found");
  if (!(email.ingested_mailboxes ?? []).map((v: string) => v.toLowerCase()).includes(ACCOUNTS_MAILBOX)) {
    throw new Error("Email was not ingested from the Accounts mailbox");
  }

  const candidate = (email.extraction as JsonRecord | null)?.supplier_invoice as JsonRecord | null;
  const supplier = text(candidate?.supplier);
  const invoiceNumber = text(candidate?.invoice_number);
  const invoiceDate = text(candidate?.invoice_date);
  const exGst = number(candidate?.amount_ex_gst);
  const gst = number(candidate?.gst);
  const total = number(candidate?.total);
  const attachments = (email.email_attachments ?? []) as Array<{ id: string; filename: string | null; mime: string | null; storage_ref: string | null; content_sha256: string | null }>;
  const sourceFiles = attachments.filter((a) => a.storage_ref && INVOICE_FILE.test(a.filename ?? ""));

  if (STATEMENT_WORD.test(`${email.subject ?? ""} ${sourceFiles.map((a) => a.filename).join(" ")}`)) {
    const reason = "The document appears to be a supplier statement; statements are reconciliation evidence and never become bills.";
    await recordFinding(emailId, "Supplier statement needs reconciliation", reason, { filenames: sourceFiles.map((a) => a.filename) });
    return { outcome: "manual_review", reason };
  }
  if (!supplier || !invoiceNumber || !/^\d{4}-\d{2}-\d{2}$/.test(invoiceDate) || exGst === null || total === null || sourceFiles.length !== 1) {
    const reason = "Invoice fields or the original attachment are incomplete or ambiguous.";
    await recordFinding(emailId, "Accounts invoice needs manual review", reason, { supplier, invoice_number: invoiceNumber, invoice_date: invoiceDate, attachment_count: sourceFiles.length });
    return { outcome: "manual_review", reason };
  }

  const { data: existingRows } = await service.from("invoices").select("id")
    .eq("source_email_id", emailId).neq("status", "voided").order("created_at", { ascending: true }).limit(1);
  const existing = existingRows?.[0];
  let invoiceId = existing?.id as string | undefined;
  if (!invoiceId) {
    const { data: matches } = await service.from("email_entity_matches")
      .select("entity_id,confidence,status").eq("email_id", emailId).eq("entity_type", "project").eq("status", "matched").gte("confidence", 0.9);
    const projectIds = [...new Set((matches ?? []).map((m) => m.entity_id).filter(Boolean))] as string[];
    if (projectIds.length !== 1) {
      const reason = "No single high-confidence Spec project match was found.";
      await recordFinding(emailId, "Accounts invoice needs a project", reason, { candidate_projects: projectIds });
      return { outcome: "manual_review", reason };
    }

    const { data: profile } = await service.from("profiles").select("id").eq("email", ACCOUNTS_MAILBOX).single();
    if (!profile) throw new Error("Stuart profile was not found");
    const source = sourceFiles[0];
    const { data: blob, error: downloadError } = await service.storage.from(ASSET_BUCKET).download(source.storage_ref!);
    if (downloadError || !blob) throw new Error("Original invoice attachment could not be loaded");
    const storagePath = `projects/${projectIds[0]}/invoices/stuart-${emailId}-${slugFilename(source.filename ?? "invoice.pdf")}`;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const { error: uploadError } = await service.storage.from(ASSET_BUCKET).upload(storagePath, bytes, { contentType: source.mime ?? blob.type ?? "application/pdf", upsert: false });
    if (uploadError && !/already exists/i.test(uploadError.message)) throw new Error(uploadError.message);

    const { data: invoice, error: insertError } = await service.from("invoices").insert({
      project_id: projectIds[0], supplier, invoice_number: invoiceNumber, invoice_date: invoiceDate,
      amount_ex_gst: exGst, gst: gst ?? Math.round((total - exGst) * 100) / 100, total,
      storage_path: storagePath, status: "unmatched", created_by: profile.id,
      source: "stuart", source_email_id: emailId,
      extracted: { ...candidate, automation: "accounts_mailbox", attachment_sha256: source.content_sha256 },
      confidence_note: "Automatically staged by Stuart from accounts@reslu.com.au; Xero creation remains DRAFT-only.",
    }).select("id").single();
    if (insertError || !invoice) throw new Error(insertError?.message ?? "Spec invoice could not be staged");
    invoiceId = invoice.id;
  }

  const { data: history } = await service.from("xero_invoices").select("contact_name,raw_json")
    .eq("invoice_type", "ACCPAY").order("invoice_date", { ascending: false }).limit(500);
  const accountCode = inferSingleExpenseAccountCode(history ?? [], supplier);
  if (!accountCode) {
    const reason = "Xero history does not provide one unambiguous expense account code for this supplier.";
    await recordFinding(emailId, "Xero account code needs confirmation", reason, { supplier, spec_invoice_id: invoiceId });
    return { outcome: "manual_review", invoice_id: invoiceId, reason };
  }

  if (!invoiceId) throw new Error("Spec invoice staging did not return an id");
  const draft = await createStuartXeroDraftBill({ invoiceId, accountCode });
  await service.from("emails").update({ status: "done", processed_at: new Date().toISOString() }).eq("id", emailId);
  await service.from("stuart_finance_findings").update({ status: "resolved", resolved_at: new Date().toISOString() }).eq("finding_key", `accounts-invoice:${emailId}`);
  return { outcome: "draft_created", invoice_id: invoiceId, xero_invoice_id: draft.xero_invoice_id };
}
