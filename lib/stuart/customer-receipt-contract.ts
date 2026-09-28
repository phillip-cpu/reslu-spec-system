import { createHash } from "node:crypto";
import { payloadSha256, type AriaAuthorityEnvelope } from "../aria-authority.ts";

export const CUSTOMER_RECEIPT_TOOL = "record_stuart_xero_customer_receipts";
export const RECEIPT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export type XeroRow = Record<string, unknown>;
export type ReceiptAllocation = {
  invoice_id: string;
  invoice_number: string;
  amount_minor: number;
  expected_due_minor: number;
  expected_paid_minor: number;
};
export type CustomerReceiptPlan = {
  tenant_id: string;
  contact_id: string;
  account_id: string;
  account_last_four: string;
  source_email_id: string;
  source_attachment_id: string;
  source_sha256: string;
  remittance_reference: string;
  received_on: string;
  currency: "AUD";
  received_total_minor: number;
  money_received_confirmed: true;
  source_reviewed_confirmed: true;
  allocations: ReceiptAllocation[];
};
export function receiptBusinessDate(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Adelaide", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
export function verifiedRemittanceHash(bytes: Uint8Array, recordedHash: string, expectedHash?: string): string {
  if (bytes.length < 8 || bytes.length > 20 * 1024 * 1024 || !Buffer.from(bytes.subarray(0, 8)).toString("ascii").startsWith("%PDF-")) throw new Error("The original remittance must be a PDF no larger than 20 MB");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== recordedHash || (expectedHash != null && sha256 !== expectedHash)) throw new Error("Remittance PDF content does not match its recorded and approved fingerprint");
  return sha256;
}

function exactKeys(row: XeroRow, keys: string[]) {
  if (Object.keys(row).some(key => !keys.includes(key)) || keys.some(key => !(key in row))) {
    throw new Error("Receipt input contains missing or unsupported fields");
  }
}
function object(value: unknown): XeroRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Receipt input must be an object");
  return value as XeroRow;
}
function minor(value: unknown, positive = false): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (positive ? 1 : 0) || value > 1_000_000_000) {
    throw new Error("Receipt amounts must be integer AUD cents within the supported range");
  }
  return value;
}

export function validateCustomerReceiptPlan(value: unknown, today = receiptBusinessDate()): CustomerReceiptPlan {
  const row = object(value);
  exactKeys(row, ["tenant_id", "contact_id", "account_id", "account_last_four", "source_email_id", "source_attachment_id", "source_sha256", "remittance_reference", "received_on", "currency", "received_total_minor", "money_received_confirmed", "source_reviewed_confirmed", "allocations"]);
  for (const key of ["tenant_id", "contact_id", "account_id", "source_email_id", "source_attachment_id"]) {
    if (typeof row[key] !== "string" || !RECEIPT_UUID.test(row[key])) throw new Error(`Exact ${key} is required`);
  }
  if (typeof row.source_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(row.source_sha256)) throw new Error("Verified source SHA-256 is required");
  if (typeof row.account_last_four !== "string" || !/^\d{4}$/.test(row.account_last_four)) throw new Error("The approved receiving account suffix is required");
  // A narrow reference alphabet prevents ambiguous normalisation in the durable natural key.
  if (typeof row.remittance_reference !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(row.remittance_reference)) throw new Error("An exact remittance reference is required");
  if (typeof row.received_on !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.received_on) || !Number.isFinite(Date.parse(row.received_on)) || new Date(row.received_on).toISOString().slice(0, 10) !== row.received_on || row.received_on > today) throw new Error("A valid actual receipt date, not a future date, is required");
  if (row.currency !== "AUD") throw new Error("Only AUD customer receipts are supported");
  if (row.money_received_confirmed !== true || row.source_reviewed_confirmed !== true) throw new Error("The exact human approval must confirm received funds and reviewed remittance evidence");
  minor(row.received_total_minor, true);
  if (!Array.isArray(row.allocations) || row.allocations.length < 1 || row.allocations.length > 20) throw new Error("One to twenty exact invoice allocations are required");
  const ids = new Set<string>();
  let total = 0;
  for (const raw of row.allocations) {
    const allocation = object(raw);
    exactKeys(allocation, ["invoice_id", "invoice_number", "amount_minor", "expected_due_minor", "expected_paid_minor"]);
    if (typeof allocation.invoice_id !== "string" || !RECEIPT_UUID.test(allocation.invoice_id) || ids.has(allocation.invoice_id)) throw new Error("Unique exact invoice IDs are required");
    ids.add(allocation.invoice_id);
    if (typeof allocation.invoice_number !== "string" || !allocation.invoice_number.trim() || allocation.invoice_number.length > 80 || /[\u0000-\u001f]/.test(allocation.invoice_number)) throw new Error("Exact invoice numbers are required");
    const amount = minor(allocation.amount_minor, true);
    if (amount > minor(allocation.expected_due_minor, true)) throw new Error("An allocation exceeds the approved outstanding balance");
    minor(allocation.expected_paid_minor);
    total += amount;
  }
  if (total !== row.received_total_minor) throw new Error("Invoice allocations must exactly equal the confirmed remittance total");
  // Detach caller-owned objects so async preflight cannot mutate an approved request.
  return JSON.parse(JSON.stringify(row)) as CustomerReceiptPlan;
}

export function customerReceiptKey(plan: CustomerReceiptPlan): string {
  return `customer-receipt:${createHash("sha256").update(`${plan.tenant_id}:${plan.contact_id}:${plan.remittance_reference.toUpperCase()}`).digest("hex")}`;
}
export function customerReceiptTarget(plan: CustomerReceiptPlan): string {
  return `${plan.tenant_id}:${plan.contact_id}:${plan.remittance_reference.toUpperCase()}`;
}
export function providerReceiptKey(plan: CustomerReceiptPlan, allocation: ReceiptAllocation): string {
  return createHash("sha256").update(`${customerReceiptKey(plan)}:${allocation.invoice_id}`).digest("hex");
}
export function customerReceiptClaimKeys(plan: CustomerReceiptPlan): string[] {
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  return [customerReceiptKey(plan), ...plan.allocations.flatMap(allocation => [
    // Source copies or altered references cannot claim the same allocation twice.
    `receipt-source:${hash(`${plan.tenant_id}:${plan.source_sha256}:${allocation.invoice_id}`)}`,
    // A re-encoded PDF has another hash. This deliberately conservative lock also
    // prevents concurrent identical invoice/date/amount receipts under another ref.
    `receipt-amount:${hash(`${plan.tenant_id}:${allocation.invoice_id}:${plan.received_on}:${allocation.amount_minor}`)}`,
  ])];
}

export function validateCustomerReceiptApproval(
  receipt: XeroRow | null,
  plan: CustomerReceiptPlan,
  authority: AriaAuthorityEnvelope,
  configuredOwnerId: string,
  ownerIsActiveAdmin: boolean,
  now = Date.now(),
) {
  const expiry = Date.parse(String(receipt?.expires_at ?? ""));
  const issued = Date.parse(String(receipt?.issued_at ?? ""));
  if (!RECEIPT_UUID.test(configuredOwnerId) || !ownerIsActiveAdmin || !receipt
    || receipt.approved_by !== configuredOwnerId || receipt.id !== authority.approval_receipt_id
    || receipt.tenant_id !== "reslu" || receipt.tool_name !== CUSTOMER_RECEIPT_TOOL
    || receipt.target_type !== "customer_remittance" || receipt.target_id !== customerReceiptTarget(plan)
    || receipt.payload_sha256 !== payloadSha256(plan) || receipt.revoked_at
    || !["task_artifact", "effect_preview"].includes(String(receipt.approval_source))
    || !Number.isFinite(expiry) || !Number.isFinite(issued) || issued > now || expiry <= now || expiry - issued > 86_400_000
    || receipt.expected_version !== plan.source_sha256 || authority.expected_version !== plan.source_sha256
    || receipt.idempotency_key !== customerReceiptKey(plan) || authority.idempotency_key !== customerReceiptKey(plan)
    || authority.expected_absent === true
    || (authority.target_type != null && authority.target_type !== "customer_remittance")
    || (authority.target_id != null && authority.target_id !== customerReceiptTarget(plan))) {
    throw new Error("An exact, unexpired approval from the configured human owner/admin is required for this remittance, source version and receipt payload");
  }
}

export function xeroMoneyMinor(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 10_000_000 || Math.abs(value * 100 - Math.round(value * 100)) > 0.000001) throw new Error("Xero returned an invalid or unsupported amount");
  return Math.round(value * 100);
}
export function xeroDate(value: unknown): string {
  if (typeof value !== "string") return "";
  const epoch = /^\/Date\((\d+)(?:[+-]\d{4})?\)\/$/.exec(value);
  if (epoch) return new Date(Number(epoch[1])).toISOString().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value) ? value.slice(0, 10) : "";
}
function nested(row: XeroRow, key: string): XeroRow { return row[key] && typeof row[key] === "object" && !Array.isArray(row[key]) ? row[key] as XeroRow : {}; }

export function verifyReceiptAccount(account: XeroRow, plan: CustomerReceiptPlan) {
  const number = typeof account.BankAccountNumber === "string" ? account.BankAccountNumber.replace(/\D/g, "") : "";
  if (account.AccountID !== plan.account_id || account.Type !== "BANK" || account.Status !== "ACTIVE" || account.CurrencyCode !== "AUD" || number.length < 4 || number.slice(-4) !== plan.account_last_four) {
    throw new Error("The approved receiving account must match one existing active AUD bank account and its verified suffix");
  }
}
export function verifyReceiptInvoice(invoice: XeroRow, plan: CustomerReceiptPlan, allocation: ReceiptAllocation, afterPayment = false) {
  const due = allocation.expected_due_minor - (afterPayment ? allocation.amount_minor : 0);
  const paid = allocation.expected_paid_minor + (afterPayment ? allocation.amount_minor : 0);
  if (invoice.InvoiceID !== allocation.invoice_id || invoice.InvoiceNumber !== allocation.invoice_number
    || invoice.Type !== "ACCREC" || invoice.CurrencyCode !== "AUD" || nested(invoice, "Contact").ContactID !== plan.contact_id
    || invoice.Status !== (due === 0 ? "PAID" : "AUTHORISED")
    || xeroMoneyMinor(invoice.AmountDue) !== due || xeroMoneyMinor(invoice.AmountPaid) !== paid) {
    throw new Error("Xero invoice identity, customer, AUD currency, authorised status or approved balances changed; review the live invoice before proceeding");
  }
}

export function assertNoExistingReceipt(payments: XeroRow[], plan: CustomerReceiptPlan, allocation: ReceiptAllocation) {
  for (const payment of payments) {
    if (nested(payment, "Invoice").InvoiceID !== allocation.invoice_id) throw new Error("Xero duplicate search returned an unexpected invoice");
    if (payment.Status === "DELETED") continue;
    if (payment.Status !== "AUTHORISED" || payment.PaymentType !== "ACCRECPAYMENT") throw new Error("Xero duplicate search contains an unrecognised payment state");
    // Same date/amount remains a possible duplicate even if a human entered another reference/account.
    if (String(payment.Reference ?? "").toUpperCase() === plan.remittance_reference.toUpperCase()
      || (xeroDate(payment.Date) === plan.received_on && xeroMoneyMinor(payment.Amount) === allocation.amount_minor)) {
      throw new Error("A possible existing customer receipt matches this remittance; inspect it instead of creating a duplicate");
    }
  }
}
export function customerReceiptPayload(plan: CustomerReceiptPlan, allocation: ReceiptAllocation) {
  return { Invoice: { InvoiceID: allocation.invoice_id }, Account: { AccountID: plan.account_id }, Date: plan.received_on, Amount: allocation.amount_minor / 100, Reference: plan.remittance_reference, IsReconciled: false };
}
export function verifyCustomerReceiptReadback(payment: XeroRow, plan: CustomerReceiptPlan, allocation: ReceiptAllocation, expectedId: string) {
  if (!RECEIPT_UUID.test(expectedId) || payment.PaymentID !== expectedId || payment.PaymentType !== "ACCRECPAYMENT"
    || payment.Status !== "AUTHORISED" || payment.HasValidationErrors === true || payment.IsReconciled !== false
    || nested(payment, "Invoice").InvoiceID !== allocation.invoice_id || nested(payment, "Invoice").Type !== "ACCREC"
    || nested(payment, "Invoice").CurrencyCode !== "AUD" || nested(payment, "Account").AccountID !== plan.account_id
    || xeroMoneyMinor(payment.Amount) !== allocation.amount_minor || xeroDate(payment.Date) !== plan.received_on
    || payment.Reference !== plan.remittance_reference || (payment.CurrencyRate != null && payment.CurrencyRate !== 1)) {
    throw new Error("Xero receipt readback did not match the exact approved incoming payment; stop for review");
  }
}
