import { createServiceRoleClient } from "@/lib/supabase/server";
import { ASSET_BUCKET } from "@/lib/storage";
import { getActiveXeroConnection, xeroGet, xeroPostJson, xeroPutBytes } from "@/lib/xero/client";

type XeroRecord = Record<string, unknown>;

export interface DraftBillInput {
  invoiceId: string;
  accountCode: string;
}

const REQUIRED_SCOPES = ["accounting.invoices", "accounting.contacts.read"] as const;

function safeFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "supplier-invoice";
}

function exactContactMatches(contacts: XeroRecord[], supplier: string): XeroRecord[] {
  const wanted = supplier.trim().toLocaleLowerCase("en-AU");
  return contacts.filter((contact) => String(contact.Name ?? "").trim().toLocaleLowerCase("en-AU") === wanted);
}

export async function createStuartXeroDraftBill(input: DraftBillInput) {
  const connection = await getActiveXeroConnection();
  if (!connection) throw new Error("Xero is not connected");
  const missingScopes = REQUIRED_SCOPES.filter((scope) => !connection.scopes.includes(scope));
  if (missingScopes.length) throw new Error("Reconnect Xero to grant Stuart draft-bill access");

  const service = createServiceRoleClient();
  const { data: invoice, error } = await service
    .from("invoices")
    .select("id,supplier,invoice_number,invoice_date,amount_ex_gst,gst,total,storage_path,status,supplier_invoice_lines(description,quantity,unit_price_ex_gst,amount_ex_gst,sort)")
    .eq("id", input.invoiceId)
    .single();
  if (error || !invoice) throw new Error(error?.message ?? "Supplier invoice was not found");
  if (invoice.status === "rejected" || invoice.status === "voided") throw new Error("Rejected or voided invoices cannot be sent to Xero");
  if (!invoice.invoice_date) throw new Error("Invoice date must be verified before creating a Xero draft");
  if (!invoice.storage_path) throw new Error("The original supplier invoice must be attached before creating a Xero draft");
  if (!/^\d{3,10}$/.test(input.accountCode.trim())) throw new Error("A valid Xero expense account code is required");

  const { data: reserved, error: reserveError } = await service
    .from("stuart_xero_draft_bills")
    .insert({ invoice_id: invoice.id, status: "creating", account_code: input.accountCode.trim() })
    .select("id")
    .single();
  if (reserveError || !reserved) {
    if (reserveError?.code === "23505") throw new Error("This Spec invoice already has a Stuart Xero draft attempt; inspect the audit record before retrying");
    throw new Error(reserveError?.message ?? "Could not reserve the Xero draft operation");
  }

  try {

  const duplicate = await xeroGet<{ Invoices?: XeroRecord[] }>(connection, "api.xro/2.0/Invoices", {
    where: `Type==\"ACCPAY\"&&InvoiceNumber==\"${invoice.invoice_number.replaceAll('"', '\\"')}\"`,
  });
  if ((duplicate.Invoices ?? []).some((row) => !["DELETED", "VOIDED"].includes(String(row.Status ?? "")))) {
    throw new Error("A live Xero supplier bill already uses this invoice number");
  }

  const contacts = await xeroGet<{ Contacts?: XeroRecord[] }>(connection, "api.xro/2.0/Contacts", {
    searchTerm: invoice.supplier,
    page: "1",
  });
  const contactMatches = exactContactMatches(contacts.Contacts ?? [], invoice.supplier);
  if (contactMatches.length !== 1 || !contactMatches[0].ContactID) {
    throw new Error("Stuart requires one exact existing Xero supplier contact; a human must resolve this supplier first");
  }

  const sourceLines = [...(invoice.supplier_invoice_lines ?? [])].sort((a, b) => a.sort - b.sort);
  const lineItems = sourceLines.length
    ? sourceLines.map((line) => ({
        Description: line.description,
        Quantity: Number(line.quantity),
        UnitAmount: line.unit_price_ex_gst === null
          ? Number(line.amount_ex_gst) / Math.max(Number(line.quantity), 1)
          : Number(line.unit_price_ex_gst),
        AccountCode: input.accountCode.trim(),
      }))
    : [{
        Description: `Supplier invoice ${invoice.invoice_number}`,
        Quantity: 1,
        UnitAmount: Number(invoice.amount_ex_gst),
        AccountCode: input.accountCode.trim(),
      }];

  const created = await xeroPostJson<{ Invoices?: XeroRecord[] }>(connection, "api.xro/2.0/Invoices", {
    Invoices: [{
      Type: "ACCPAY",
      Contact: { ContactID: contactMatches[0].ContactID },
      Date: invoice.invoice_date,
      InvoiceNumber: invoice.invoice_number,
      LineAmountTypes: "Exclusive",
      Status: "DRAFT",
      LineItems: lineItems,
    }],
  });
  const xeroInvoice = created.Invoices?.[0];
  const xeroInvoiceId = typeof xeroInvoice?.InvoiceID === "string" ? xeroInvoice.InvoiceID : null;
  if (!xeroInvoiceId || xeroInvoice?.Status !== "DRAFT") throw new Error("Xero did not return a draft supplier bill");

  const { error: createdAuditError } = await service
    .from("stuart_xero_draft_bills")
    .update({ xero_invoice_id: xeroInvoiceId, status: "draft_created", updated_at: new Date().toISOString() })
    .eq("id", reserved.id);
  if (createdAuditError) throw new Error("Draft created, but its audit record could not be updated");

  if (connection.scopes.includes("accounting.attachments")) {
    const { data: file, error: downloadError } = await service.storage.from(ASSET_BUCKET).download(invoice.storage_path);
    if (downloadError || !file) throw new Error("Draft created, but the source attachment could not be loaded");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const filename = `${safeFilename(invoice.supplier)}-${safeFilename(invoice.invoice_number)}.pdf`;
    await xeroPutBytes(connection, `api.xro/2.0/Invoices/${xeroInvoiceId}/Attachments/${encodeURIComponent(filename)}`, bytes, file.type || "application/pdf");
  }

  await service
    .from("stuart_xero_draft_bills")
    .update({ status: "complete", attachment_uploaded: connection.scopes.includes("accounting.attachments"), updated_at: new Date().toISOString() })
    .eq("id", reserved.id);

  return {
    invoice_id: invoice.id,
    xero_invoice_id: xeroInvoiceId,
    status: "DRAFT" as const,
    attachment_uploaded: connection.scopes.includes("accounting.attachments"),
    human_action: "Review and approve the draft bill inside Xero; Stuart cannot approve or pay it.",
  };
  } catch (error) {
    await service
      .from("stuart_xero_draft_bills")
      .update({ status: "failed", safe_error: error instanceof Error ? error.message.slice(0, 500) : "Xero draft failed", updated_at: new Date().toISOString() })
      .eq("id", reserved.id);
    throw error;
  }
}
