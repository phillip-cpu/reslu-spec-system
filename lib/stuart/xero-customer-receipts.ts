import { randomUUID } from "node:crypto";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { payloadSha256, validatedAuthorityEnvelope } from "@/lib/aria-authority";
import { getActiveXeroConnection, xeroGet, xeroPutJson } from "@/lib/xero/client";
import {
  CUSTOMER_RECEIPT_TOOL, RECEIPT_UUID, customerReceiptClaimKeys,
  customerReceiptTarget, validateCustomerReceiptApproval, validateCustomerReceiptPlan,
  type XeroRow,
} from "./customer-receipt-contract";
import { executeCustomerReceipts, type ReceiptLineResult, type ReceiptResult } from "./customer-receipt-engine";
import { loadCustomerRemittanceSource } from "./xero-customer-receipt-source";

export function customerReceiptsEnabled(): boolean {
  return process.env.STUART_XERO_CUSTOMER_RECEIPTS_ENABLED === "true";
}

/** Internal server implementation. Disabled by default; never called by email intake. */
export async function recordStuartXeroCustomerReceipts(raw: unknown, rawAuthority: unknown, actorId: string) {
  if (!customerReceiptsEnabled()) throw new Error("Customer receipt recording is disabled pending reviewed activation");
  const plan = validateCustomerReceiptPlan(raw);
  const authority = validatedAuthorityEnvelope(rawAuthority);
  const ownerId = process.env.STUART_XERO_RECEIPTS_OWNER_PROFILE_ID ?? "";
  if (!RECEIPT_UUID.test(ownerId)) throw new Error("The customer receipt approval owner is not configured");
  const service = createServiceRoleClient();
  const digest = payloadSha256(plan);
  const connection = await getActiveXeroConnection();
  if (!connection || connection.tenant_id !== plan.tenant_id) throw new Error("The exact approved Xero tenant is not connected");
  let claimedIds: string[] = [];

  async function assertAuthority() {
    if (!customerReceiptsEnabled()) throw new Error("Customer receipt recording has been disabled");
    const [agentResult, policyResult, approvalResult, ownerResult, ownerAgentResult, ownerUserResult] = await Promise.all([
      service.from("conversation_agents").select("id").eq("slug", "stuart").eq("active", true).eq("auth_profile_id", actorId).maybeSingle(),
      service.from("aria_tool_registry").select("active,risk_tier,action_class,approval_rule,allowed_agent_slugs,verification_kind").eq("tool_name", CUSTOMER_RECEIPT_TOOL).maybeSingle(),
      service.from("aria_approval_receipts").select("*").eq("id", authority.approval_receipt_id ?? "00000000-0000-4000-8000-000000000000").maybeSingle(),
      service.from("profiles").select("id,role").eq("id", ownerId).maybeSingle(),
      service.from("conversation_agents").select("id").eq("auth_profile_id", ownerId).limit(1),
      service.auth.admin.getUserById(ownerId),
    ]);
    if (agentResult.error || !agentResult.data) throw new Error("An active authenticated Stuart identity is required");
    const policy = policyResult.data;
    if (policyResult.error || !policy || policy.active !== true || policy.risk_tier !== "R2" || policy.action_class !== "commit"
      || policy.approval_rule !== "exact-owner" || policy.verification_kind !== "provider_readback"
      || !Array.isArray(policy.allowed_agent_slugs) || policy.allowed_agent_slugs.length !== 1 || policy.allowed_agent_slugs[0] !== "stuart") {
      throw new Error("The governed customer receipt capability is disabled or does not have its exact receipt policy");
    }
    const owner = ownerUserResult.data.user;
    const bannedUntil = owner?.banned_until ? Date.parse(owner.banned_until) : 0;
    const ownerIsActiveAdmin = !ownerResult.error && ownerResult.data?.role === "admin" && !ownerAgentResult.error
      && ownerAgentResult.data?.length === 0 && !ownerUserResult.error && Boolean(owner?.email_confirmed_at)
      && Number.isFinite(bannedUntil) && bannedUntil <= Date.now();
    if (approvalResult.error) throw new Error("The receipt approval could not be verified");
    validateCustomerReceiptApproval(approvalResult.data, plan, authority, ownerId, ownerIsActiveAdmin);
  }

  async function verifySource() {
    await loadCustomerRemittanceSource(plan.source_email_id, plan.source_attachment_id, plan.source_sha256);
    // The hash proves document identity; the approval's source_reviewed_confirmed
    // proves the owner reviewed the allocation. Email content alone is never authority.
  }

  async function verifyConnection() {
    const latest = await getActiveXeroConnection();
    if (!latest || latest.id !== connection!.id || latest.tenant_id !== plan.tenant_id) throw new Error("Xero connection changed after receipt approval");
    for (const alternatives of [["accounting.payments"], ["accounting.invoices", "accounting.invoices.read"], ["accounting.settings.read", "accounting.settings"]]) {
      if (!alternatives.some(scope => latest.scopes.includes(scope))) throw new Error(`Xero receipt recording requires separately reviewed consent for ${alternatives[0]}; existing access was not broadened`);
    }
    const org = await xeroGet<{ Organisations?: XeroRow[] }>(connection!, "api.xro/2.0/Organisation");
    if (!Array.isArray(org.Organisations) || org.Organisations.length !== 1 || org.Organisations[0].BaseCurrency !== "AUD") throw new Error("The connected Xero organisation must have AUD base currency");
  }
  async function single(path: string, collection: "Accounts" | "Invoices" | "Payments"): Promise<XeroRow> {
    const response = await xeroGet<Record<string, unknown>>(connection!, path);
    const rows = response[collection];
    if (!Array.isArray(rows) || rows.length !== 1 || !rows[0] || typeof rows[0] !== "object") throw new Error(`Xero did not return one exact ${collection} record`);
    return rows[0] as XeroRow;
  }
  async function payments(invoiceId: string): Promise<XeroRow[]> {
    const found: XeroRow[] = [];
    for (let page = 1; page <= 10; page++) {
      const response = await xeroGet<{ Payments?: XeroRow[] }>(connection!, "api.xro/2.0/Payments", { where: `Invoice.InvoiceID==Guid("${invoiceId}")`, page: String(page), pageSize: "100" });
      if (!Array.isArray(response.Payments)) throw new Error("Xero did not confirm the existing-payment search");
      found.push(...response.Payments);
      if (response.Payments.length < 100) return found;
    }
    throw new Error("Existing-payment search exceeded its bound; manual review is required");
  }
  const metadata = (lines: ReceiptLineResult[]) => ({ transport: "stuart-customer-receipts", xero_tenant_id: plan.tenant_id, source_attachment_id: plan.source_attachment_id, source_sha256: plan.source_sha256, allocations: lines });
  async function claim(): Promise<string> {
    const rootId = randomUUID();
    const rows = customerReceiptClaimKeys(plan).map((key, index) => ({
      id: index === 0 ? rootId : randomUUID(), tool_name: CUSTOMER_RECEIPT_TOOL, risk_tier: "R2", target_type: "customer_remittance", target_id: customerReceiptTarget(plan),
      request_id: authority.request_id, correlation_id: authority.correlation_id, idempotency_key: key, payload_sha256: digest,
      expected_version: plan.source_sha256, expected_absent: false, approval_receipt_id: authority.approval_receipt_id,
      authorization_kind: "exact-approval", actor_profile_id: actorId, state: "executing",
      metadata: { ...metadata([]), root_action_run_id: rootId, allocation_lock: index > 0 },
    }));
    // One SQL INSERT reserves all keys atomically under the existing unique index.
    // Do not upsert: a previous timeout/crash must never become a fresh permission to write.
    const { data, error } = await service.from("aria_action_runs").insert(rows).select("id");
    if (error || !data || data.length !== rows.length) throw new Error("This remittance or allocation could not be claimed; an existing attempt may have recorded it. Inspect the durable audit and Xero before retrying");
    claimedIds = data.map(row => row.id);
    return rootId;
  }
  async function checkpoint(actionId: string, lines: ReceiptLineResult[]) {
    const { data, error } = await service.from("aria_action_runs").update({ metadata: { ...metadata(lines), root_action_run_id: actionId, allocation_lock: false } })
      .eq("id", actionId).eq("state", "executing").select("id").single();
    if (error || !data) throw new Error("Receipt progress could not be durably saved; do not repeat any attempted payment");
  }
  async function finish(result: ReceiptResult) {
    const receiptRef = result.state === "verified" ? `reslu://provider_readback/${CUSTOMER_RECEIPT_TOOL}/${result.action_run_id}` : null;
    const { error } = await service.from("aria_action_receipts").insert({ action_run_id: result.action_run_id, outcome: result.state, receipt_ref: receiptRef, result_sha256: payloadSha256(result), resulting_version: null,
      verification_kind: result.state === "verified" ? "provider_readback" : "none", verification_evidence: result, recorded_by: actorId });
    if (error) throw new Error("The receipt outcome audit could not be saved");
    const { data, error: stateError } = await service.from("aria_action_runs").update({ state: result.state, finished_at: new Date().toISOString() }).in("id", claimedIds).select("id");
    if (stateError || data?.length !== claimedIds.length) throw new Error("The receipt outcome state could not be saved");
  }
  return executeCustomerReceipts(plan, {
    assertAuthority, verifySource, verifyConnection,
    getAccount: () => single(`api.xro/2.0/Accounts/${plan.account_id}`, "Accounts"),
    getInvoice: id => single(`api.xro/2.0/Invoices/${id}`, "Invoices"),
    getPayments: payments,
    getPayment: id => single(`api.xro/2.0/Payments/${id}`, "Payments"),
    claim, checkpoint, finish,
    createPayment: async (payload, idempotencyKey) => {
      const response = await xeroPutJson<{ Payments?: XeroRow[] }>(connection, "api.xro/2.0/Payments", { Payments: [payload] }, idempotencyKey);
      if (!Array.isArray(response.Payments) || response.Payments.length !== 1) throw new Error("Xero did not confirm exactly one receipt; inspect Xero before retrying");
      return response.Payments[0];
    },
  });
}
