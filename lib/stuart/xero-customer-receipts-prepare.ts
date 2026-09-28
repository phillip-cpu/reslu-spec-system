import { createServiceRoleClient } from "@/lib/supabase/server";
import { getActiveXeroConnection, xeroGet } from "@/lib/xero/client";
import { loadCustomerRemittanceSource } from "./xero-customer-receipt-source";
import { prepareCustomerReceiptPlan, receiptWhereLiteral, validateReceiptPreparation } from "./customer-receipt-preparation";
import type { XeroRow } from "./customer-receipt-contract";

export async function prepareStuartXeroCustomerReceipts(raw: unknown, actorId: string) {
  if (process.env.STUART_XERO_CUSTOMER_RECEIPT_PREPARATION_ENABLED !== "true"
    && process.env.STUART_XERO_CUSTOMER_RECEIPTS_ENABLED !== "true") throw new Error("Customer receipt preparation is disabled pending reviewed activation");
  const input = validateReceiptPreparation(raw);
  const service = createServiceRoleClient();
  const { data: agent, error } = await service.from("conversation_agents").select("id").eq("slug", "stuart").eq("active", true).eq("auth_profile_id", actorId).maybeSingle();
  if (error || !agent) throw new Error("An active authenticated Stuart identity is required");
  const { data: policy, error: policyError } = await service.from("aria_tool_registry").select("active,risk_tier,action_class,approval_rule,allowed_agent_slugs").eq("tool_name", "prepare_stuart_xero_customer_receipts").maybeSingle();
  if (policyError || !policy || policy.active !== true || policy.risk_tier !== "R0" || policy.action_class !== "read" || policy.approval_rule !== "none"
    || !Array.isArray(policy.allowed_agent_slugs) || policy.allowed_agent_slugs.length !== 1 || policy.allowed_agent_slugs[0] !== "stuart") throw new Error("The read-only customer receipt preparation policy is disabled");
  const connection = await getActiveXeroConnection();
  if (!connection) throw new Error("Xero is not connected");
  for (const alternatives of [["accounting.payments.read", "accounting.payments"], ["accounting.invoices.read", "accounting.invoices"], ["accounting.settings.read", "accounting.settings"], ["accounting.contacts.read", "accounting.contacts"]]) {
    if (!alternatives.some(scope => connection.scopes.includes(scope))) throw new Error(`Xero receipt preparation requires existing ${alternatives[0]} access`);
  }
  async function rows(collection: string, query?: Record<string, string>): Promise<XeroRow[]> {
    const data = await xeroGet<Record<string, unknown>>(connection!, `api.xro/2.0/${collection}`, query);
    if (!Array.isArray(data[collection])) throw new Error(`Xero did not confirm the ${collection} query`);
    return data[collection] as XeroRow[];
  }
  return prepareCustomerReceiptPlan(input, {
    getSource: () => loadCustomerRemittanceSource(input.source_email_id, input.source_attachment_id),
    getTenant: async () => {
      const orgs = await xeroGet<{ Organisations?: XeroRow[] }>(connection, "api.xro/2.0/Organisation");
      if (!orgs.Organisations || orgs.Organisations.length !== 1) throw new Error("Xero did not return one organisation");
      return { id: connection.tenant_id, name: String(orgs.Organisations[0].Name ?? connection.tenant_name), currency: String(orgs.Organisations[0].BaseCurrency ?? "") };
    },
    getContacts: name => rows("Contacts", { where: `Name=="${receiptWhereLiteral(name)}"` }),
    getAccounts: () => rows("Accounts"),
    getInvoices: (number, contactId) => rows("Invoices", { where: `InvoiceNumber=="${receiptWhereLiteral(number)}"&&Contact.ContactID==Guid("${contactId}")` }),
    getPayments: async invoiceId => {
      const found: XeroRow[] = [];
      for (let page = 1; page <= 10; page++) {
        const data = await rows("Payments", { where: `Invoice.InvoiceID==Guid("${invoiceId}")`, page: String(page), pageSize: "100" });
        found.push(...data); if (data.length < 100) return found;
      }
      throw new Error("Existing-payment search exceeded its bound; manual review is required");
    },
  });
}
