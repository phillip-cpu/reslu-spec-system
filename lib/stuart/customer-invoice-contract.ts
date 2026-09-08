export const CUSTOMER_INVOICE_TOOL = "create_stuart_xero_draft_customer_invoice";
export const CUSTOMER_INVOICE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type CustomerInvoiceLine = { description: string; amount_ex_gst: number; gst: number; account_code: string; tax_type: string };
export type CustomerInvoiceInput = {
  source_attachment_id: string; source_sha256: string; invoice_number: string;
  issuer_name: string; customer_name: string; contact_id: string;
  invoice_date: string; due_date: string; currency: "AUD"; reference: string;
  subtotal_ex_gst: number; gst: number; total_inc_gst: number; lines: CustomerInvoiceLine[];
  issued_to_client?: boolean;
};
export type CustomerInvoiceReconciliation = {
  rule: "issued-client-invoice-one-cent-v1";
  line_index: number | null;
  adjustment_ex_gst: number;
  source_line_amount_ex_gst: number | null;
  resulting_line_amount_ex_gst: number | null;
  source_subtotal_ex_gst: number;
  source_line_subtotal_ex_gst: number;
  resulting_subtotal_ex_gst: number;
  total_inc_gst: number;
  gst: number;
  note: string;
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

export function prepareCustomerInvoice(value: unknown): { input: CustomerInvoiceInput; reconciliation: CustomerInvoiceReconciliation | null } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A customer invoice is required");
  const input = value as CustomerInvoiceInput;
  if (!CUSTOMER_INVOICE_UUID.test(input.source_attachment_id ?? "") || !CUSTOMER_INVOICE_UUID.test(input.contact_id ?? "")) throw new Error("Exact source attachment and existing Xero contact IDs are required");
  if (!/^[a-f0-9]{64}$/.test(input.source_sha256 ?? "")) throw new Error("The verified source SHA-256 is required");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(input.invoice_number ?? "")) throw new Error("Invalid customer invoice number");
  for (const key of ["issuer_name", "customer_name", "reference"] as const) requiredText(input[key], key, 255);
  if (!validDate(input.invoice_date) || !validDate(input.due_date) || input.due_date < input.invoice_date) throw new Error("Verified invoice and due dates are required");
  if (input.currency !== "AUD") throw new Error("Only verified AUD customer invoices are supported");
  if (input.issued_to_client !== undefined && typeof input.issued_to_client !== "boolean") throw new Error("Issued-to-client confirmation must be a boolean");
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
  const total = invoiceCents(input.total_inc_gst);
  const headerTax = invoiceCents(input.gst);
  const headerSubtotal = invoiceCents(input.subtotal_ex_gst);
  if (total <= 0 || headerTax < 0 || headerSubtotal < 0) throw new Error("Invoice total must be positive and header amounts non-negative");
  if (subtotal === headerSubtotal && tax === headerTax && subtotal + tax === total) return { input, reconciliation: null };

  // The issued document's total and GST are authoritative. Only reconcile a
  // one-cent net-line/subtotal discrepancy; never recalculate or move its GST.
  const targetSubtotal = total - headerTax;
  const delta = targetSubtotal - subtotal;
  if (input.issued_to_client !== true || tax !== headerTax || targetSubtotal < 0 || Math.abs(delta) > 1 || Math.abs(targetSubtotal - headerSubtotal) > 1 || Math.abs(subtotal - headerSubtotal) > 1) {
    throw new Error("Source lines, GST and header totals disagree beyond the issued-invoice one-cent net reconciliation rule. Preserve the issued total, GST and PDF; review the discrepancy.");
  }
  let lineIndex: number | null = null;
  if (delta !== 0) {
    // Largest positive net line, first on a tie: deterministic across retries.
    for (let index = 0; index < input.lines.length; index++) {
      if (input.lines[index].amount_ex_gst > 0 && (lineIndex === null || input.lines[index].amount_ex_gst > input.lines[lineIndex].amount_ex_gst)) lineIndex = index;
    }
    if (lineIndex === null || invoiceCents(input.lines[lineIndex].amount_ex_gst) + delta < 0) throw new Error("No safe existing net line can absorb the one-cent reconciliation");
  }
  const reconciled = { ...input, subtotal_ex_gst: targetSubtotal / 100, lines: input.lines.map((line, index) => ({ ...line, amount_ex_gst: index === lineIndex ? (invoiceCents(line.amount_ex_gst) + delta) / 100 : line.amount_ex_gst })) };
  return { input: reconciled, reconciliation: {
    rule: "issued-client-invoice-one-cent-v1", line_index: lineIndex, adjustment_ex_gst: delta / 100,
    source_line_amount_ex_gst: lineIndex === null ? null : input.lines[lineIndex].amount_ex_gst,
    resulting_line_amount_ex_gst: lineIndex === null ? null : reconciled.lines[lineIndex].amount_ex_gst,
    source_subtotal_ex_gst: input.subtotal_ex_gst, source_line_subtotal_ex_gst: subtotal / 100,
    resulting_subtotal_ex_gst: targetSubtotal / 100, total_inc_gst: input.total_inc_gst, gst: input.gst,
    note: "The invoice already sent to the client is authoritative. Reconciled only the Xero draft net amount to its issued total and GST; original PDF, tax amounts and client-facing invoice remain unchanged.",
  } };
}

export function validateCustomerInvoice(value: unknown): CustomerInvoiceInput { return prepareCustomerInvoice(value).input; }

export function customerInvoiceKey(invoiceNumber: string) { return `xero-customer-invoice:${invoiceNumber}`; }

export function validateCustomerInvoiceApproval(receipt: Record<string, unknown> | null, payloadHash: string, invoiceNumber: string, authority: { approval_receipt_id?: string | null; idempotency_key: string; expected_version?: string | null; expected_absent?: boolean }, now = Date.now()) {
  const expiry = Date.parse(String(receipt?.expires_at ?? ""));
  if (!receipt || !authority.approval_receipt_id || receipt.id !== authority.approval_receipt_id || receipt.tool_name !== CUSTOMER_INVOICE_TOOL || receipt.tenant_id !== "reslu" || receipt.target_type !== "customer_invoice" || receipt.target_id !== invoiceNumber || !receipt.approved_by || receipt.revoked_at || !Number.isFinite(expiry) || expiry <= now || receipt.payload_sha256 !== payloadHash
    || receipt.idempotency_key !== customerInvoiceKey(invoiceNumber) || authority.idempotency_key !== receipt.idempotency_key || receipt.expected_version != null || authority.expected_version != null || authority.expected_absent !== true) throw new Error("The exact customer invoice needs an unexpired owner approval, expected_absent=true and its invoice-scoped idempotency key");
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
