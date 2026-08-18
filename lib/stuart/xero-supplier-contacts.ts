import { createServiceRoleClient } from "@/lib/supabase/server";
import { getActiveXeroConnection, xeroGet, xeroPutJson } from "@/lib/xero/client";
import { isValidAustralianAbn, normalizeAustralianAbn } from "@/lib/stuart/supplier-identity";

type XeroContact = Record<string, unknown>;

export interface CreateSupplierContactInput {
  invoiceId: string;
  legalName: string;
  abn: string;
  humanConfirmed: boolean;
  createdBy?: string | null;
}

function normalizedName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-AU");
}

function evidenceHasName(text: string, legalName: string): boolean {
  return normalizedName(text).includes(normalizedName(legalName));
}

function evidenceHasAbn(text: string, abn: string): boolean {
  const digitRuns = text.match(/[\d\s-]{11,}/g) ?? [];
  return digitRuns.some((run) => normalizeAustralianAbn(run).includes(abn));
}

function contactId(contact: XeroContact | undefined): string | null {
  return typeof contact?.ContactID === "string" && contact.ContactID ? contact.ContactID : null;
}

function contactTaxNumber(contact: XeroContact): string {
  return normalizeAustralianAbn(typeof contact.TaxNumber === "string" ? contact.TaxNumber : "");
}

function liveContacts(contacts: XeroContact[]): XeroContact[] {
  return contacts.filter((contact) => !["ARCHIVED", "GDPRREQUEST"].includes(String(contact.ContactStatus ?? "")));
}

function xeroWhereLiteral(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export async function createStuartXeroSupplierContact(input: CreateSupplierContactInput) {
  if (input.humanConfirmed !== true) {
    throw new Error("Exact human approval is required before Stuart creates a Xero supplier contact");
  }
  const legalName = input.legalName.trim().replace(/\s+/g, " ");
  if (legalName.length < 2 || legalName.length > 255) throw new Error("Supplier legal name is invalid");
  const taxNumber = normalizeAustralianAbn(input.abn);
  if (!isValidAustralianAbn(taxNumber)) throw new Error("A valid 11-digit Australian ABN is required");

  const connection = await getActiveXeroConnection();
  if (!connection) throw new Error("Xero is not connected");
  if (!connection.scopes.includes("accounting.contacts")) {
    throw new Error("Reconnect Xero to grant Stuart contact-create access");
  }

  const service = createServiceRoleClient();
  const { data: invoice, error: invoiceError } = await service
    .from("invoices")
    .select("id,supplier,storage_path,status")
    .eq("id", input.invoiceId)
    .single();
  if (invoiceError || !invoice) throw new Error(invoiceError?.message ?? "Supplier invoice was not found");
  if (["rejected", "voided"].includes(invoice.status)) throw new Error("Rejected or voided invoices cannot authorise a supplier contact");
  if (!invoice.storage_path) throw new Error("The original supplier invoice must be attached before creating its contact");
  if (normalizedName(invoice.supplier) !== normalizedName(legalName)) {
    throw new Error("The approved legal name must exactly match the supplier on the Spec invoice");
  }

  const { data: source, error: sourceError } = await service
    .from("email_attachments")
    .select("extracted_text")
    .eq("storage_ref", invoice.storage_path)
    .single();
  if (sourceError || !source?.extracted_text) throw new Error("The attached original has no readable verification evidence");
  if (!evidenceHasName(source.extracted_text, legalName) || !evidenceHasAbn(source.extracted_text, taxNumber)) {
    throw new Error("The supplier legal name and ABN must both match the attached original");
  }

  const { data: prior } = await service
    .from("stuart_xero_supplier_contacts")
    .select("id,status,xero_contact_id,legal_name,tax_number")
    .eq("connection_id", connection.id)
    .eq("source_invoice_id", invoice.id)
    .maybeSingle();
  if (prior?.status === "created" && prior.xero_contact_id) {
    return {
      invoice_id: invoice.id,
      xero_contact_id: prior.xero_contact_id,
      legal_name: prior.legal_name,
      abn: prior.tax_number,
      status: "EXISTING" as const,
      human_action: "Create the source-backed Xero draft bill; Stuart cannot approve or pay it.",
    };
  }
  if (prior?.status === "creating") throw new Error("This supplier contact creation is already in progress");

  const byName = await xeroGet<{ Contacts?: XeroContact[] }>(connection, "api.xro/2.0/Contacts", {
    where: `Name==\"${xeroWhereLiteral(legalName)}\"`,
  });
  const byAbn = await xeroGet<{ Contacts?: XeroContact[] }>(connection, "api.xro/2.0/Contacts", {
    where: `TaxNumber==\"${taxNumber}\"`,
  });
  const named = liveContacts(byName.Contacts ?? []).filter((contact) => normalizedName(String(contact.Name ?? "")) === normalizedName(legalName));
  const taxed = liveContacts(byAbn.Contacts ?? []).filter((contact) => contactTaxNumber(contact) === taxNumber);
  const conflicts = [...named, ...taxed].filter((contact, index, all) => {
    const id = contactId(contact);
    return id && all.findIndex((other) => contactId(other) === id) === index
      && (normalizedName(String(contact.Name ?? "")) !== normalizedName(legalName) || contactTaxNumber(contact) !== taxNumber);
  });
  if (conflicts.length) throw new Error("A Xero contact already uses this legal name or ABN with different details; a human must resolve it");
  const exact = [...named, ...taxed].find((contact) => normalizedName(String(contact.Name ?? "")) === normalizedName(legalName) && contactTaxNumber(contact) === taxNumber);

  const reservation = prior
    ? service.from("stuart_xero_supplier_contacts").update({
        legal_name: legalName, tax_number: taxNumber, status: "creating", safe_error: null,
        created_by: input.createdBy ?? null, updated_at: new Date().toISOString(),
      }).eq("id", prior.id).select("id").single()
    : service.from("stuart_xero_supplier_contacts").insert({
        connection_id: connection.id, source_invoice_id: invoice.id, legal_name: legalName,
        tax_number: taxNumber, status: "creating", created_by: input.createdBy ?? null,
      }).select("id").single();
  const { data: reserved, error: reservationError } = await reservation;
  if (reservationError || !reserved) throw new Error(reservationError?.message ?? "Could not reserve the supplier-contact operation");

  try {
    let xeroContact = exact;
    let resultStatus: "CREATED" | "EXISTING" = "EXISTING";
    if (!xeroContact) {
      const created = await xeroPutJson<{ Contacts?: XeroContact[] }>(connection, "api.xro/2.0/Contacts", {
        Contacts: [{ Name: legalName, TaxNumber: taxNumber }],
      });
      xeroContact = created.Contacts?.[0];
      resultStatus = "CREATED";
    }
    const xeroContactId = contactId(xeroContact);
    if (!xeroContactId) throw new Error("Xero did not return a contact identifier");

    const readback = await xeroGet<{ Contacts?: XeroContact[] }>(connection, `api.xro/2.0/Contacts/${xeroContactId}`);
    const verified = readback.Contacts?.[0];
    if (!verified
      || normalizedName(String(verified.Name ?? "")) !== normalizedName(legalName)
      || contactTaxNumber(verified) !== taxNumber
      || ["ARCHIVED", "GDPRREQUEST"].includes(String(verified.ContactStatus ?? ""))) {
      throw new Error("Xero contact readback did not match the approved supplier identity");
    }
    const { error: auditError } = await service.from("stuart_xero_supplier_contacts").update({
      xero_contact_id: xeroContactId, status: "created", safe_error: null, updated_at: new Date().toISOString(),
    }).eq("id", reserved.id);
    if (auditError) throw new Error("Contact created, but its audit record could not be updated");

    return {
      invoice_id: invoice.id,
      xero_contact_id: xeroContactId,
      legal_name: legalName,
      abn: taxNumber,
      status: resultStatus,
      human_action: "Create the source-backed Xero draft bill; Stuart cannot approve or pay it.",
    };
  } catch (error) {
    await service.from("stuart_xero_supplier_contacts").update({
      status: "failed",
      safe_error: error instanceof Error ? error.message.slice(0, 500) : "Xero contact creation failed",
      updated_at: new Date().toISOString(),
    }).eq("id", reserved.id);
    throw error;
  }
}
