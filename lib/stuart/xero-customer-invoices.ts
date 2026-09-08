import { createHash } from "node:crypto";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { payloadSha256, validatedAuthorityEnvelope } from "@/lib/aria-authority";
import { ASSET_BUCKET } from "@/lib/storage";
import { getActiveXeroConnection, xeroGet, xeroPostJson, xeroPutBytes } from "@/lib/xero/client";
import { CUSTOMER_INVOICE_TOOL, CUSTOMER_INVOICE_UUID, customerInvoiceKey, customerInvoicePayload, validateCustomerInvoice, validateCustomerInvoiceApproval, verifyCustomerInvoiceReadback } from "./customer-invoice-contract";

type XeroRecord = Record<string, unknown>;
const normalizedName = (value: unknown) => String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();

async function requireStuartActor(actorId: string) {
  const service = createServiceRoleClient();
  const { data: actor, error } = await service.from("conversation_agents").select("id").eq("slug", "stuart").eq("active", true).eq("auth_profile_id", actorId).maybeSingle();
  if (error || !actor) throw new Error("An active Stuart identity is required");
}

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

export async function customerInvoiceSource(attachmentId: string, actorId: string) {
  await requireStuartActor(actorId);
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

export async function createStuartXeroDraftCustomerInvoice(raw: unknown, rawAuthority: unknown, actorId: string) {
  // Validate first: in particular, never round away source/header conflicts.
  const input = validateCustomerInvoice(raw);
  const authority = validatedAuthorityEnvelope(rawAuthority);
  await requireStuartActor(actorId);
  const service = createServiceRoleClient();
  const { data: policy, error: policyError } = await service.from("aria_tool_registry").select("risk_tier,approval_rule,allowed_agent_slugs,active").eq("tool_name", CUSTOMER_INVOICE_TOOL).single();
  if (policyError || !policy || !policy.active || policy.risk_tier !== "R2" || policy.approval_rule !== "exact-owner" || !policy.allowed_agent_slugs.includes("stuart")) throw new Error("The controlled customer invoice capability is disabled");
  const digest = payloadSha256(raw);
  const approval = await service.from("aria_approval_receipts").select("*").eq("id", authority.approval_receipt_id ?? "").maybeSingle();
  if (approval.error) throw new Error("The owner approval could not be verified");
  validateCustomerInvoiceApproval(approval.data, digest, input.invoice_number, authority);
  const { data: previous, error: previousError } = await service.from("aria_action_runs").select("id,state,payload_sha256,actor_profile_id,metadata").eq("tool_name", CUSTOMER_INVOICE_TOOL).eq("idempotency_key", customerInvoiceKey(input.invoice_number)).maybeSingle();
  if (previousError) throw new Error("Could not check the customer invoice audit");
  if (previous) {
    if (previous.payload_sha256 !== digest || previous.actor_profile_id !== actorId) throw new Error("An earlier attempt exists with different details; inspect it before proceeding");
    return { replayed: true, action_run_id: previous.id, completion_state: previous.state, message: "This invoice was already claimed. No creation was repeated; inspect its existing audit and Xero record." };
  }
  const { source, bytes, sha256 } = await loadSource(input.source_attachment_id);
  if (sha256 !== input.source_sha256) throw new Error("The source PDF differs from the approved document");
  const connection = await getActiveXeroConnection();
  if (!connection) throw new Error("Xero is not connected");
  for (const alternatives of [["accounting.invoices"], ["accounting.attachments"], ["accounting.contacts.read", "accounting.contacts"], ["accounting.settings.read", "accounting.settings"]]) {
    if (!alternatives.some(scope => connection.scopes.includes(scope))) throw new Error("Reconnect Xero with invoice, attachment, contact-read and settings-read access");
  }
  const duplicate = await xeroGet<{ Invoices?: XeroRecord[] }>(connection, "api.xro/2.0/Invoices", { where: `Type=="ACCREC"&&InvoiceNumber=="${input.invoice_number}"` });
  if (!Array.isArray(duplicate.Invoices)) throw new Error("Xero did not confirm the duplicate check; no draft was attempted");
  if (duplicate.Invoices.length) throw new Error("This customer invoice number already exists in Xero, including deleted/voided history. Review it; no duplicate was created.");
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
  // Claim only after read-only preflight, so a rejected preflight does not lock
  // an invoice forever. The ledger's unique (tenant_id,tool_name,idempotency_key)
  // constraint makes this an atomic one-shot reservation across concurrent calls.
  const reapproval = await service.from("aria_approval_receipts").select("*").eq("id", authority.approval_receipt_id!).maybeSingle();
  if (reapproval.error) throw new Error("The owner approval could not be rechecked");
  validateCustomerInvoiceApproval(reapproval.data, digest, input.invoice_number, authority);
  const { data: action, error: claimError } = await service.from("aria_action_runs").insert({
    tool_name: CUSTOMER_INVOICE_TOOL, risk_tier: "R2", target_type: "customer_invoice", target_id: input.invoice_number,
    request_id: authority.request_id, correlation_id: authority.correlation_id, idempotency_key: customerInvoiceKey(input.invoice_number),
    payload_sha256: digest, expected_absent: true, approval_receipt_id: authority.approval_receipt_id,
    authorization_kind: "exact-approval", actor_profile_id: actorId, state: "verifying", metadata: { transport: "stuart-customer-invoice" },
  }).select("id,metadata").single();
  if (claimError || !action) throw new Error("This draft operation could not be claimed; inspect its audit before retrying");
  const actionId = action.id;
  async function finish(outcome: "verified" | "partial", result: Record<string, unknown>) {
    const receiptRef = outcome === "verified" ? `reslu://provider_readback/${CUSTOMER_INVOICE_TOOL}/${result.provider_id}` : null;
    const { error: auditError } = await service.from("aria_action_receipts").insert({ action_run_id: actionId, outcome, receipt_ref: receiptRef, result_sha256: payloadSha256(result), resulting_version: outcome === "verified" ? "DRAFT" : null, verification_kind: outcome === "verified" ? "provider_readback" : "none", verification_evidence: result, recorded_by: actorId });
    if (auditError) throw new Error("Xero outcome requires audit review; do not repeat creation");
    const { error: stateError } = await service.from("aria_action_runs").update({ state: outcome, finished_at: new Date().toISOString() }).eq("id", actionId);
    if (stateError) throw new Error("Outcome receipt saved but action state update failed; do not repeat creation");
    return receiptRef;
  }
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
    const result = { provider_id: xeroInvoiceId, xero_invoice_id: xeroInvoiceId, invoice_number: input.invoice_number, invoice_type: "ACCREC", status: "DRAFT", attachment_uploaded: true, provider_readback_verified: true, human_action: "Review the draft in Xero. Nothing was authorised, sent or paid." };
    return { ...result, receipt_ref: await finish("verified", result) };
  } catch (error) {
    await service.from("aria_action_runs").update({ metadata: { ...action.metadata, customer_invoice: { xero_invoice_id: xeroInvoiceId, source_attachment_id: source.id, source_sha256: sha256, stage: "inspect_before_retry" } } }).eq("id", action.id);
    await finish("partial", { xero_invoice_id: xeroInvoiceId, stage: "inspect_before_retry" }).catch(() => null);
    throw new Error(`${error instanceof Error ? error.message : "Customer draft outcome is uncertain"}${xeroInvoiceId ? ` Existing Xero draft: ${xeroInvoiceId}.` : " No successful creation is confirmed; check Xero before retrying."}`);
  }
}
