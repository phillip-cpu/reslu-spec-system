import {
  RECEIPT_UUID, assertNoExistingReceipt, customerReceiptKey, customerReceiptTarget, validateCustomerReceiptPlan,
  verifyReceiptAccount, verifyReceiptInvoice, xeroMoneyMinor, receiptBusinessDate, type CustomerReceiptPlan, type XeroRow,
} from "./customer-receipt-contract.ts";

export type ReceiptPreparationInput = {
  customer_name: string; account_last_four: string; source_email_id: string; source_attachment_id: string;
  remittance_reference: string; received_on: string; currency: "AUD"; received_total_minor: number;
  allocations: Array<{ invoice_number: string; amount_minor: number }>;
};
export type ReceiptPreparationPorts = {
  getSource(): Promise<{ sha256: string; filename: string }>;
  getTenant(): Promise<{ id: string; name: string; currency: string }>;
  getContacts(name: string): Promise<XeroRow[]>;
  getAccounts(): Promise<XeroRow[]>;
  getInvoices(number: string, contactId: string): Promise<XeroRow[]>;
  getPayments(invoiceId: string): Promise<XeroRow[]>;
};
export function receiptWhereLiteral(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export function validateReceiptPreparation(raw: unknown): ReceiptPreparationInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("An exact remittance preparation request is required");
  const row = raw as Record<string, unknown>;
  const keys = ["customer_name", "account_last_four", "source_email_id", "source_attachment_id", "remittance_reference", "received_on", "currency", "received_total_minor", "allocations"];
  if (Object.keys(row).some(key => !keys.includes(key)) || keys.some(key => !(key in row))) throw new Error("Preparation contains missing or unsupported fields");
  if (typeof row.customer_name !== "string" || !row.customer_name.trim() || row.customer_name.length > 255 || /[\u0000-\u001f]/.test(row.customer_name)) throw new Error("An exact existing customer name is required");
  if (typeof row.source_email_id !== "string" || !RECEIPT_UUID.test(row.source_email_id) || typeof row.source_attachment_id !== "string" || !RECEIPT_UUID.test(row.source_attachment_id)) throw new Error("Exact source email and attachment IDs are required");
  if (typeof row.account_last_four !== "string" || !/^\d{4}$/.test(row.account_last_four)) throw new Error("A verified receiving account suffix is required");
  if (typeof row.remittance_reference !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(row.remittance_reference)) throw new Error("An exact remittance reference is required");
  if (row.currency !== "AUD" || !Number.isSafeInteger(row.received_total_minor) || Number(row.received_total_minor) <= 0 || Number(row.received_total_minor) > 1_000_000_000) throw new Error("A positive AUD remittance total in cents is required");
  if (typeof row.received_on !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.received_on) || !Number.isFinite(Date.parse(row.received_on)) || new Date(row.received_on).toISOString().slice(0, 10) !== row.received_on || row.received_on > receiptBusinessDate()) throw new Error("The actual non-future receipt date is required");
  if (!Array.isArray(row.allocations) || row.allocations.length < 1 || row.allocations.length > 20) throw new Error("One to twenty remittance allocations are required");
  const numbers = new Set(); let total = 0;
  for (const allocation of row.allocations) {
    if (!allocation || typeof allocation !== "object" || Array.isArray(allocation) || Object.keys(allocation).length !== 2 || typeof allocation.invoice_number !== "string" || !allocation.invoice_number.trim() || allocation.invoice_number.length > 80 || /[\u0000-\u001f]/.test(allocation.invoice_number) || numbers.has(allocation.invoice_number) || !Number.isSafeInteger(allocation.amount_minor) || allocation.amount_minor <= 0 || allocation.amount_minor > 1_000_000_000) throw new Error("Unique exact invoice numbers and positive integer-cent allocations are required");
    numbers.add(allocation.invoice_number); total += allocation.amount_minor;
  }
  if (total !== row.received_total_minor) throw new Error("Allocations must exactly equal the remittance total");
  return structuredClone(row) as ReceiptPreparationInput;
}

/** Read-only preparation: returns a non-executable proposal, never approval or confirmation. */
export async function prepareCustomerReceiptPlan(raw: unknown, ports: ReceiptPreparationPorts) {
  const input = validateReceiptPreparation(raw);
  const source = await ports.getSource();
  const tenant = await ports.getTenant();
  if (!RECEIPT_UUID.test(tenant.id) || tenant.currency !== "AUD") throw new Error("One exact AUD Xero organisation is required");
  const normalizeName = (value: unknown) => String(value ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-AU");
  const contacts = (await ports.getContacts(input.customer_name)).filter(contact => contact.ContactStatus === "ACTIVE" && normalizeName(contact.Name) === normalizeName(input.customer_name));
  if (contacts.length !== 1 || typeof contacts[0].ContactID !== "string" || !RECEIPT_UUID.test(contacts[0].ContactID)) throw new Error("The customer name must resolve to exactly one existing active Xero contact");
  const accounts = (await ports.getAccounts()).filter(account => account.Type === "BANK" && account.Status === "ACTIVE" && account.CurrencyCode === "AUD" && typeof account.BankAccountNumber === "string" && account.BankAccountNumber.replace(/\D/g, "").slice(-4) === input.account_last_four);
  if (accounts.length !== 1 || typeof accounts[0].AccountID !== "string" || !RECEIPT_UUID.test(accounts[0].AccountID)) throw new Error("The suffix must resolve to exactly one existing active AUD bank account; ambiguous accounts require human selection");
  const allocations: CustomerReceiptPlan["allocations"] = [];
  for (const allocation of input.allocations) {
    const rows = await ports.getInvoices(allocation.invoice_number, contacts[0].ContactID);
    if (rows.length !== 1 || rows[0].InvoiceNumber !== allocation.invoice_number || typeof rows[0].InvoiceID !== "string" || !RECEIPT_UUID.test(rows[0].InvoiceID)) throw new Error("Each exact customer invoice number must resolve to one live Xero invoice");
    allocations.push({ invoice_id: rows[0].InvoiceID, invoice_number: allocation.invoice_number, amount_minor: allocation.amount_minor, expected_due_minor: xeroMoneyMinor(rows[0].AmountDue), expected_paid_minor: xeroMoneyMinor(rows[0].AmountPaid) });
    const candidate = { ...input, tenant_id: tenant.id, contact_id: contacts[0].ContactID, account_id: accounts[0].AccountID, source_sha256: source.sha256, allocations, money_received_confirmed: true as const, source_reviewed_confirmed: true as const };
    // This is identity/balance validation only. Confirmations are stripped below.
    verifyReceiptInvoice(rows[0], candidate, allocations[allocations.length - 1]);
  }
  const { customer_name: _customerName, ...rest } = input;
  const validated = validateCustomerReceiptPlan({ ...rest, tenant_id: tenant.id, contact_id: contacts[0].ContactID, account_id: accounts[0].AccountID, source_sha256: source.sha256, allocations, money_received_confirmed: true, source_reviewed_confirmed: true });
  verifyReceiptAccount(accounts[0], validated);
  for (const allocation of validated.allocations) assertNoExistingReceipt(await ports.getPayments(allocation.invoice_id), validated, allocation);
  return {
    state: "prepared_read_only" as const,
    retrieved_at: new Date().toISOString(),
    organisation: { id: tenant.id, name: tenant.name, currency: tenant.currency },
    customer: { id: contacts[0].ContactID, name: String(contacts[0].Name ?? "") },
    receiving_account: { id: accounts[0].AccountID, name: String(accounts[0].Name ?? ""), last_four: input.account_last_four, currency: "AUD" },
    source: { email_id: input.source_email_id, attachment_id: input.source_attachment_id, filename: source.filename, sha256: source.sha256 },
    proposed_plan: { ...validated, money_received_confirmed: false as const, source_reviewed_confirmed: false as const },
    authority_target: { target_type: "customer_remittance", target_id: customerReceiptTarget(validated), idempotency_key: customerReceiptKey(validated), expected_version: validated.source_sha256, expected_absent: false },
    message: "Read-only proposal. The source hash verifies document identity, not its contents or bank receipt. The configured human owner must inspect the remittance, confirm funds are received into this exact account and approve the final exact plan. Confirmation flags remain false. No approval was issued and no Xero or Spec financial record was changed.",
  };
}
