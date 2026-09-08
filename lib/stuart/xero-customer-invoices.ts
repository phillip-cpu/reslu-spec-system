import { createHash } from "node:crypto";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { payloadSha256 } from "@/lib/aria-authority";
import { ASSET_BUCKET } from "@/lib/storage";
import { getActiveXeroConnection, xeroGet, xeroPostJson, xeroPutBytes } from "@/lib/xero/client";
import { CUSTOMER_INVOICE_UUID, customerInvoiceKey, customerInvoicePayload, validateCustomerInvoice, validateCustomerInvoiceAuthority, verifyCustomerInvoiceReadback } from "./customer-invoice-contract";

type XeroRecord = Record<string, unknown>;
const normalizedName = (value: unknown) => String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();

async function loadSource(attachmentId: string) {
  if (!CUSTOMER_INVOICE_UUID.test(attachmentId)) throw new Error("An exact conversation attachment ID is required");
  const service = createServiceRoleClient();
  const { data: source, error } = await service.from("conversation_attachments")
    .select("id,conversation_id,message_id,filename,mime_type,byte_size,status,storage_path").eq("id", attachmentId).single();
  if (error || !source || source.status !== "ready" || source.mime_type !== "application/pdf" || !source.message_id || source.byte_size > 20 * 1024 * 1024) throw new Error("A ready, shared PDF no larger than 20 MB is required");
  const { data: member, error: memberError } = await service.from("conversation_participants")
    .select("agent:conversation_agents!inner(slug)").eq("conversation_id", source.conversation_id).eq("agent.slug", "stuart").maybeSingle();
  if (memberError || !member) throw new Error("Stuart is not a participant in this source conversation");
  const { data: message, error: messageError } = await service.from("conversation_messages")
    .select("id").eq("id", source.message_id).eq("conversation_id", source.conversation_id).is("deleted_at", null).maybeSingle();
  if (messageError || !message) throw new Error("The original source message is unavailable");
  const { data: file, error: downloadError } = await service.storage.from(ASSET_BUCKET).download(source.storage_path);
  if (downloadError || !file) throw new Error("The original PDF could not be loaded");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length !== source.byte_size || !Buffer.from(bytes.subarray(0, 8)).toString("ascii").startsWith("%PDF-")) throw new Error("The source PDF failed its integrity check");
  return { source, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export async function customerInvoiceSource(attachmentId: string) {
  const { source, sha256 } = await loadSource(attachmentId);
  const connection = await getActiveXeroConnection();
  let xeroOptions: Record<string, unknown> = { connected: false };
  if (connection) {
    const organisations = await xeroGet<{ Organisations?: XeroRecord[] }>(connection, "api.xro/2.0/Organisation");
    const accounts = await xeroGet<{ Accounts?: XeroRecord[] }>(connection, "api.xro/2.0/Accounts");
    const taxes = await xeroGet<{ TaxRates?: XeroRecord[] }>(connection, "api.xro/2.0/TaxRates");
    xeroOptions = { connected: true,
      issuer_names: (organisations.Organisations ?? []).map(org => org.LegalName ?? org.Name),
      revenue_accounts: (accounts.Accounts ?? []).filter(account => account.Status === "ACTIVE" && ["REVENUE", "SALES", "OTHERINCOME"].includes(String(account.Type))).slice(0, 40).map(account => ({ code: account.Code, name: account.Name })),
      sales_tax_codes: (taxes.TaxRates ?? []).filter(tax => tax.Status === "ACTIVE" && tax.CanApplyToRevenue === true).slice(0, 25).map(tax => ({ code: tax.TaxType, name: tax.Name })),
    };
  }
  return { source_attachment_id: source.id, conversation_id: source.conversation_id, filename: source.filename, byte_size: source.byte_size, source_sha256: sha256,
    source_preview_url: `/api/conversations/${source.conversation_id}/attachments?attachment_id=${source.id}`, xero_options: xeroOptions,
    authority: "Read-only source identity, not content verification. Inspect the original PDF and obtain exact approval of issuer, customer, dates, lines, tax and account codes before creating a draft. No Xero record changed." };
}

export async function createStuartXeroDraftCustomerInvoice(raw: unknown, actionRunId: string, actorId: string) {
  // Validate first: in particular, never round away source/header conflicts.
  const input = validateCustomerInvoice(raw);
  if (!CUSTOMER_INVOICE_UUID.test(actionRunId)) throw new Error("An exact approved action run is required");
  const service = createServiceRoleClient();
  const { data: action, error: actionError } = await service.from("aria_action_runs")
    .select("id,tool_name,actor_profile_id,payload_sha256,approval_receipt_id,authorization_kind,risk_tier,state,idempotency_key,started_at,metadata")
    .eq("id", actionRunId).single();
  if (actionError || !action) throw new Error("An approved customer-invoice action was not found");
  validateCustomerInvoiceAuthority(action, actorId, payloadSha256(raw), input.invoice_number);
  const { data: receipt, error: receiptError } = await service.from("aria_approval_receipts").select("expires_at,revoked_at").eq("id", action.approval_receipt_id).single();
  if (receiptError || !receipt || receipt.revoked_at || !Number.isFinite(Date.parse(receipt.expires_at)) || Date.parse(receipt.expires_at) <= Date.now()) throw new Error("Customer invoice approval has expired or was revoked");
  const { source, bytes, sha256 } = await loadSource(input.source_attachment_id);
  if (sha256 !== input.source_sha256) throw new Error("The source PDF differs from the approved document");
  const connection = await getActiveXeroConnection();
  if (!connection) throw new Error("Xero is not connected");
  for (const alternatives of [["accounting.invoices"], ["accounting.attachments"], ["accounting.contacts.read", "accounting.contacts"], ["accounting.settings.read", "accounting.settings"]]) {
    if (!alternatives.some(scope => connection.scopes.includes(scope))) throw new Error("Reconnect Xero with invoice, attachment, contact-read and settings-read access");
  }
  const duplicate = await xeroGet<{ Invoices?: XeroRecord[] }>(connection, "api.xro/2.0/Invoices", { where: `Type=="ACCREC"&&InvoiceNumber=="${input.invoice_number}"` });
  if ((duplicate.Invoices ?? []).length) throw new Error("This customer invoice number already exists in Xero, including deleted/voided history. Review it; no duplicate was created.");
  const contacts = await xeroGet<{ Contacts?: XeroRecord[] }>(connection, `api.xro/2.0/Contacts/${input.contact_id}`);
  const contact = contacts.Contacts?.[0];
  if (!contact || contact.ContactID !== input.contact_id || contact.ContactStatus !== "ACTIVE" || normalizedName(contact.Name) !== normalizedName(input.customer_name)) throw new Error("The approved customer does not match one active existing Xero contact");
  const organisations = await xeroGet<{ Organisations?: XeroRecord[] }>(connection, "api.xro/2.0/Organisation");
  if (!organisations.Organisations?.some(org => normalizedName(org.LegalName ?? org.Name) === normalizedName(input.issuer_name))) throw new Error("The source issuer does not match the connected Xero organisation");
  const accounts = await xeroGet<{ Accounts?: XeroRecord[] }>(connection, "api.xro/2.0/Accounts");
  const taxes = await xeroGet<{ TaxRates?: XeroRecord[] }>(connection, "api.xro/2.0/TaxRates");
  for (const line of input.lines) {
    if (!accounts.Accounts?.some(account => account.Code === line.account_code && account.Status === "ACTIVE" && ["REVENUE", "SALES", "OTHERINCOME"].includes(String(account.Type)))) throw new Error("Every approved account must be an active Xero revenue account");
    if (!taxes.TaxRates?.some(tax => tax.TaxType === line.tax_type && tax.Status === "ACTIVE" && tax.CanApplyToRevenue === true)) throw new Error("Every approved tax code must be active and applicable to revenue");
  }
  // Atomic one-shot claim on the existing immutable-key action ledger.
  // A concurrent call or uncertain timeout must NEVER repeat the provider write.
  const { data: claimed, error: claimError } = await service.from("aria_action_runs").update({ state: "verifying" }).eq("id", action.id).eq("state", "executing").select("id").maybeSingle();
  if (claimError || !claimed) throw new Error("This draft operation is already claimed; inspect its audit before any retry");
  let xeroInvoiceId: string | null = null;
  try {
    const created = await xeroPostJson<{ Invoices?: XeroRecord[] }>(connection, "api.xro/2.0/Invoices", { Invoices: [customerInvoicePayload(input)] }, createHash("sha256").update(`${connection.tenant_id}:${customerInvoiceKey(input.invoice_number)}`).digest("hex"));
    const draft = created.Invoices?.[0];
    xeroInvoiceId = typeof draft?.InvoiceID === "string" ? draft.InvoiceID : null;
    if (!xeroInvoiceId || !CUSTOMER_INVOICE_UUID.test(xeroInvoiceId) || draft?.HasErrors === true || draft?.Status !== "DRAFT") throw new Error("Xero did not confirm a draft customer invoice; inspect the audit before retrying");
    const { error: auditError } = await service.from("aria_action_runs").update({ metadata: { ...action.metadata, customer_invoice: { xero_invoice_id: xeroInvoiceId, source_attachment_id: source.id, source_sha256: sha256, stage: "draft_created" } } }).eq("id", action.id);
    if (auditError) throw new Error("Draft created but audit update failed; do not retry creation");
    const filename = `source-${source.id}.pdf`;
    await xeroPutBytes(connection, `api.xro/2.0/Invoices/${xeroInvoiceId}/Attachments/${filename}`, bytes, "application/pdf");
    const readback = await xeroGet<{ Invoices?: XeroRecord[] }>(connection, `api.xro/2.0/Invoices/${xeroInvoiceId}`);
    verifyCustomerInvoiceReadback(readback.Invoices?.[0] ?? {}, input);
    const attached = await xeroGet<{ Attachments?: XeroRecord[] }>(connection, `api.xro/2.0/Invoices/${xeroInvoiceId}/Attachments`);
    if (!attached.Attachments?.some(file => file.FileName === filename && Number(file.ContentLength) === bytes.length)) throw new Error("Draft exists but its source attachment was not verified");
    return { provider_id: xeroInvoiceId, xero_invoice_id: xeroInvoiceId, invoice_number: input.invoice_number, invoice_type: "ACCREC", status: "DRAFT", attachment_uploaded: true, provider_readback_verified: true, human_action: "Review the draft in Xero. Nothing was authorised, sent or paid." };
  } catch (error) {
    await service.from("aria_action_runs").update({ state: "partial", metadata: { ...action.metadata, customer_invoice: { xero_invoice_id: xeroInvoiceId, source_attachment_id: source.id, source_sha256: sha256, stage: "inspect_before_retry" } } }).eq("id", action.id);
    throw new Error(`${error instanceof Error ? error.message : "Customer draft outcome is uncertain"}${xeroInvoiceId ? ` Existing Xero draft: ${xeroInvoiceId}.` : " No successful creation is confirmed; check Xero before retrying."}`);
  }
}
