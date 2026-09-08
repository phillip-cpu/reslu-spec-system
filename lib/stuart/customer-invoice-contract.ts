export const CUSTOMER_INVOICE_TOOL = "create_stuart_xero_draft_customer_invoice";
export const CUSTOMER_INVOICE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type CustomerInvoiceLine = { description: string; amount_ex_gst: number; gst: number; account_code: string; tax_type: string };
export type CustomerInvoiceInput = {
  source_attachment_id: string; source_sha256: string; invoice_number: string;
  issuer_name: string; customer_name: string; contact_id: string;
  invoice_date: string; due_date: string; currency: "AUD"; reference: string;
  subtotal_ex_gst: number; gst: number; total_inc_gst: number; lines: CustomerInvoiceLine[];
};

export function invoiceCents(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 100000000) throw new Error("Invoice amounts must be finite numbers within the supported range");
  const cents = Math.round(value * 100);
  if (Math.abs(value * 100 - cents) > 0.000001) throw new Error("Invoice amounts must have no more than two decimal places");
  return cents;
}

function requiredText(value: unknown, name: string, max: number) {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) throw new Error(`Invalid ${name}`);
}
function validDate(value: unknown) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

export function validateCustomerInvoice(value: unknown): CustomerInvoiceInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A customer invoice is required");
  const input = value as CustomerInvoiceInput;
  if (!CUSTOMER_INVOICE_UUID.test(input.source_attachment_id ?? "") || !CUSTOMER_INVOICE_UUID.test(input.contact_id ?? "")) throw new Error("Exact source attachment and existing Xero contact IDs are required");
  if (!/^[a-f0-9]{64}$/.test(input.source_sha256 ?? "")) throw new Error("The verified source SHA-256 is required");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(input.invoice_number ?? "")) throw new Error("Invalid customer invoice number");
  for (const key of ["issuer_name", "customer_name", "reference"] as const) requiredText(input[key], key, 255);
  if (!validDate(input.invoice_date) || !validDate(input.due_date) || input.due_date < input.invoice_date) throw new Error("Verified invoice and due dates are required");
  if (input.currency !== "AUD") throw new Error("Only verified AUD customer invoices are supported");
  if (!Array.isArray(input.lines) || !input.lines.length || input.lines.length > 100) throw new Error("One to 100 verified source lines are required");
  let subtotal = 0; let tax = 0;
  for (const line of input.lines) {
    if (!line || typeof line !== "object") throw new Error("Invalid source line");
    requiredText(line.description, "line description", 2000);
    if (!/^[A-Za-z0-9-]{1,10}$/.test(line.account_code ?? "") || !/^[A-Z0-9]{1,30}$/.test(line.tax_type ?? "")) throw new Error("Every line needs approved revenue-account and sales-tax codes");
    const amount = invoiceCents(line.amount_ex_gst); const gst = invoiceCents(line.gst);
    if (amount < 0 || gst < 0) throw new Error("Credits and negative adjustments require a separate reviewed workflow");
    subtotal += amount; tax += gst;
  }
  if (invoiceCents(input.total_inc_gst) <= 0) throw new Error("Invoice total must be positive");
  if (subtotal !== invoiceCents(input.subtotal_ex_gst) || tax !== invoiceCents(input.gst) || subtotal + tax !== invoiceCents(input.total_inc_gst)) {
    throw new Error("Source lines, GST and header totals disagree. Resolve the discrepancy explicitly before approving a draft; no automatic rounding adjustment is allowed.");
  }
  return input;
}

export function customerInvoiceKey(invoiceNumber: string) { return `xero-customer-invoice:${invoiceNumber}`; }

export function validateCustomerInvoiceAuthority(action: Record<string, unknown> | null, actorId: string, payloadHash: string, invoiceNumber: string, now = Date.now()) {
  const started = Date.parse(String(action?.started_at ?? ""));
  if (!action || action.tool_name !== CUSTOMER_INVOICE_TOOL || action.actor_profile_id !== actorId || action.risk_tier !== "R2" || action.authorization_kind !== "exact-approval" || !action.approval_receipt_id || action.payload_sha256 !== payloadHash || action.state !== "executing"
    || action.idempotency_key !== customerInvoiceKey(invoiceNumber) || !Number.isFinite(started) || now - started > 15 * 60 * 1000 || started > now + 60000) throw new Error("The exact customer invoice needs a fresh owner approval and its invoice-scoped idempotency key");
}

export function customerInvoicePayload(input: CustomerInvoiceInput) {
  return { Type: "ACCREC", Status: "DRAFT", CurrencyCode: "AUD", LineAmountTypes: "Exclusive",
    Contact: { ContactID: input.contact_id }, InvoiceNumber: input.invoice_number,
    Date: input.invoice_date, DueDate: input.due_date, Reference: input.reference,
    LineItems: input.lines.map(line => ({ Description: line.description, Quantity: 1, UnitAmount: line.amount_ex_gst, LineAmount: line.amount_ex_gst, TaxAmount: line.gst, TaxType: line.tax_type, AccountCode: line.account_code })),
  };
}

export function verifyCustomerInvoiceReadback(row: Record<string, unknown>, input: CustomerInvoiceInput) {
  const contact = row.Contact as { ContactID?: string } | undefined;
  const date = (value: unknown) => typeof value === "string" ? value.slice(0, 10) : "";
  if (row.Type !== "ACCREC" || row.Status !== "DRAFT" || row.CurrencyCode !== "AUD" || row.InvoiceNumber !== input.invoice_number || row.Reference !== input.reference || row.LineAmountTypes !== "Exclusive" || contact?.ContactID !== input.contact_id
    || date(row.DateString ?? row.Date) !== input.invoice_date || date(row.DueDateString ?? row.DueDate) !== input.due_date
    || invoiceCents(row.SubTotal) !== invoiceCents(input.subtotal_ex_gst) || invoiceCents(row.TotalTax) !== invoiceCents(input.gst) || invoiceCents(row.Total) !== invoiceCents(input.total_inc_gst)) throw new Error("Xero draft readback differs from the approved customer invoice; review the existing record before any retry");
  const lines = row.LineItems as Record<string, unknown>[] | undefined;
  if (!Array.isArray(lines) || lines.length !== input.lines.length || lines.some((line, index) => line.Description !== input.lines[index].description || line.AccountCode !== input.lines[index].account_code || line.TaxType !== input.lines[index].tax_type || invoiceCents(line.LineAmount) !== invoiceCents(input.lines[index].amount_ex_gst) || invoiceCents(line.TaxAmount) !== invoiceCents(input.lines[index].gst))) throw new Error("Xero draft line readback differs from the approved lines");
}
