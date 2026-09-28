import assert from "node:assert/strict";
import test from "node:test";
import { payloadSha256 } from "../aria-authority.ts";
import {
  CUSTOMER_RECEIPT_TOOL, assertNoExistingReceipt, customerReceiptClaimKeys, customerReceiptKey, customerReceiptPayload,
  customerReceiptTarget, validateCustomerReceiptApproval, validateCustomerReceiptPlan, verifyCustomerReceiptReadback,
  verifyReceiptAccount, verifyReceiptInvoice, xeroDate, type CustomerReceiptPlan, type XeroRow,
} from "./customer-receipt-contract.ts";
import { executeCustomerReceipts, type ReceiptPorts, type ReceiptResult } from "./customer-receipt-engine.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = Date.parse("2026-09-28T10:00:00Z");
function plan(): CustomerReceiptPlan {
  return { tenant_id: id(1), contact_id: id(2), account_id: id(3), account_last_four: "1234", source_email_id: id(4), source_attachment_id: id(5), source_sha256: "a".repeat(64), remittance_reference: "TEST-REMIT-01", received_on: "2026-09-24", currency: "AUD", received_total_minor: 30000, money_received_confirmed: true, source_reviewed_confirmed: true,
    allocations: [{ invoice_id: id(6), invoice_number: "TEST-INV-1", amount_minor: 10000, expected_due_minor: 10000, expected_paid_minor: 0 }, { invoice_id: id(7), invoice_number: "TEST-INV-2", amount_minor: 20000, expected_due_minor: 30000, expected_paid_minor: 5000 }] };
}
function approval(p = plan()) {
  return { id: id(20), approved_by: id(21), tenant_id: "reslu", tool_name: CUSTOMER_RECEIPT_TOOL, target_type: "customer_remittance", target_id: customerReceiptTarget(p), payload_sha256: payloadSha256(p), expected_version: p.source_sha256, idempotency_key: customerReceiptKey(p), approval_source: "task_artifact", issued_at: "2026-09-28T09:55:00Z", expires_at: "2026-09-28T10:30:00Z", revoked_at: null };
}
function envelope(p = plan()) {
  return { request_id: "test-request", correlation_id: "test-correlation", idempotency_key: customerReceiptKey(p), expected_version: p.source_sha256, expected_absent: false, approval_receipt_id: id(20) };
}
function invoice(p: CustomerReceiptPlan, index: number): XeroRow {
  const allocation = p.allocations[index];
  return { InvoiceID: allocation.invoice_id, InvoiceNumber: allocation.invoice_number, Type: "ACCREC", Status: "AUTHORISED", CurrencyCode: "AUD", Contact: { ContactID: p.contact_id }, AmountDue: allocation.expected_due_minor / 100, AmountPaid: allocation.expected_paid_minor / 100 };
}
function payment(p: CustomerReceiptPlan, index = 0): XeroRow {
  return { ...customerReceiptPayload(p, p.allocations[index]), PaymentID: id(30 + index), PaymentType: "ACCRECPAYMENT", Status: "AUTHORISED", CurrencyRate: 1,
    Invoice: { InvoiceID: p.allocations[index].invoice_id, Type: "ACCREC", CurrencyCode: "AUD" } };
}
function harness(p = plan()) {
  const invoices = new Map(p.allocations.map((allocation, index) => [allocation.invoice_id, invoice(p, index)]));
  const payments = new Map<string, XeroRow>();
  const claims = new Set<string>();
  const writes: unknown[] = [];
  const checkpoints: unknown[] = [];
  const finishes: ReceiptResult[] = [];
  let authCalls = 0;
  const ports: ReceiptPorts = {
    assertAuthority: async () => { authCalls++; }, verifySource: async () => {}, verifyConnection: async () => {},
    getAccount: async () => ({ AccountID: p.account_id, Type: "BANK", Status: "ACTIVE", CurrencyCode: "AUD", BankAccountNumber: "TEST-1234" }),
    getInvoice: async invoiceId => structuredClone(invoices.get(invoiceId)!),
    getPayments: async invoiceId => [...payments.values()].filter(row => (row.Invoice as XeroRow).InvoiceID === invoiceId),
    getPayment: async paymentId => structuredClone(payments.get(paymentId)!),
    claim: async () => {
      const keys = customerReceiptClaimKeys(p);
      if (keys.some(key => claims.has(key))) throw new Error("already claimed");
      keys.forEach(key => claims.add(key));
      return id(40);
    },
    checkpoint: async (_action, lines) => { checkpoints.push(structuredClone(lines)); },
    createPayment: async (payload, key) => {
      writes.push({ payload, key });
      const index = p.allocations.findIndex(allocation => allocation.invoice_id === payload.Invoice.InvoiceID);
      const paid = payment(p, index);
      payments.set(paid.PaymentID as string, paid);
      const existing = invoices.get(payload.Invoice.InvoiceID)!;
      existing.AmountDue = (p.allocations[index].expected_due_minor - p.allocations[index].amount_minor) / 100;
      existing.AmountPaid = (p.allocations[index].expected_paid_minor + p.allocations[index].amount_minor) / 100;
      existing.Status = existing.AmountDue === 0 ? "PAID" : "AUTHORISED";
      return structuredClone(paid);
    },
    finish: async result => { finishes.push(structuredClone(result)); },
  };
  return { ports, writes, invoices, payments, claims, checkpoints, finishes, authCalls: () => authCalls };
}

test("receipt validation accepts exact integer-cent allocations including a partial invoice receipt", () => {
  assert.deepEqual(validateCustomerReceiptPlan(plan()), plan());
  const original = plan(); const copy = validateCustomerReceiptPlan(original); original.allocations[0].amount_minor = 1;
  assert.equal(copy.allocations[0].amount_minor, 10000);
});
for (const [name, change] of [
  ["outgoing document override", (p: CustomerReceiptPlan) => Object.assign(p, { CreditNote: { CreditNoteID: id(99) } })],
  ["unconfirmed funds", (p: CustomerReceiptPlan) => Object.assign(p, { money_received_confirmed: false })],
  ["unreviewed source", (p: CustomerReceiptPlan) => Object.assign(p, { source_reviewed_confirmed: false })],
  ["foreign currency", (p: CustomerReceiptPlan) => Object.assign(p, { currency: "USD" })],
  ["fractional cents", (p: CustomerReceiptPlan) => { p.allocations[0].amount_minor = 1.2; }],
  ["negative allocation", (p: CustomerReceiptPlan) => { p.allocations[0].amount_minor = -1; }],
  ["over-allocation", (p: CustomerReceiptPlan) => { p.allocations[0].amount_minor = 10001; }],
  ["mismatched total", (p: CustomerReceiptPlan) => { p.received_total_minor++; }],
  ["duplicate invoice", (p: CustomerReceiptPlan) => { p.allocations[1].invoice_id = p.allocations[0].invoice_id; }],
  ["invalid date", (p: CustomerReceiptPlan) => { p.received_on = "2026-02-30"; }],
  ["future date", (p: CustomerReceiptPlan) => { p.received_on = "2099-01-01"; }],
  ["zero receipt", (p: CustomerReceiptPlan) => { p.received_total_minor = 0; }],
  ["arbitrary allocation field", (p: CustomerReceiptPlan) => Object.assign(p.allocations[0], { IsReconciled: true })],
] as const) {
  test(`rejects ${name}`, () => { const p = plan(); change(p); assert.throws(() => validateCustomerReceiptPlan(p)); });
}

test("exact configured human/admin approval is required; email flags alone are insufficient", () => {
  const p = plan();
  validateCustomerReceiptApproval(approval(p), p, envelope(p), id(21), true, now);
  assert.throws(() => validateCustomerReceiptApproval(null, p, envelope(p), id(21), true, now));
  assert.throws(() => validateCustomerReceiptApproval(approval(p), p, envelope(p), id(22), true, now));
  assert.throws(() => validateCustomerReceiptApproval(approval(p), p, envelope(p), id(21), false, now));
});
for (const [name, changed] of [
  ["expired", { expires_at: "2026-09-28T09:00:00Z" }], ["invalid expiry", { expires_at: "invalid" }],
  ["revoked", { revoked_at: "2026-09-28T09:59:00Z" }], ["standing policy", { approval_source: "standing_policy_exception" }],
  ["wrong target", { target_id: "other" }], ["wrong payload", { payload_sha256: "b".repeat(64) }],
  ["changed document", { expected_version: "b".repeat(64) }], ["different operation", { tool_name: "pay_supplier" }],
] as const) {
  test(`rejects ${name} approval`, () => assert.throws(() => validateCustomerReceiptApproval({ ...approval(), ...changed }, plan(), envelope(), id(21), true, now)));
}
test("claim keys survive request/reference/source-copy changes", () => {
  const p = plan(); const sourceCopy = { ...p, source_attachment_id: id(70), source_email_id: id(71), remittance_reference: "DIFFERENT" };
  assert.ok(customerReceiptClaimKeys(p).some(key => customerReceiptClaimKeys(sourceCopy).includes(key)));
  const reencoded = { ...sourceCopy, source_sha256: "b".repeat(64) };
  assert.ok(customerReceiptClaimKeys(p).some(key => customerReceiptClaimKeys(reencoded).includes(key)));
  assert.equal(customerReceiptKey(p), customerReceiptKey({ ...p, remittance_reference: p.remittance_reference.toLowerCase() }));
  assert.notEqual(customerReceiptKey(p), customerReceiptKey({ ...p, tenant_id: id(72) }));
});

test("bank account must be the exact active AUD bank account", () => {
  const p = plan(); const valid = { AccountID: p.account_id, Type: "BANK", Status: "ACTIVE", CurrencyCode: "AUD", BankAccountNumber: "TEST-1234" };
  verifyReceiptAccount(valid, p);
  for (const changed of [{ AccountID: id(90) }, { Type: "CURRENT" }, { Status: "ARCHIVED" }, { CurrencyCode: "USD" }, { BankAccountNumber: "9876" }]) assert.throws(() => verifyReceiptAccount({ ...valid, ...changed }, p));
});
test("invoice must remain the exact customer ACCREC authorised invoice and approved balance", () => {
  const p = plan(); const valid = invoice(p, 0);
  verifyReceiptInvoice(valid, p, p.allocations[0]);
  for (const changed of [{ Type: "ACCPAY" }, { Status: "DRAFT" }, { Status: "PAID" }, { CurrencyCode: "NZD" }, { AmountDue: 99 }, { AmountPaid: 1 }, { InvoiceID: id(90) }, { Contact: { ContactID: id(90) } }]) assert.throws(() => verifyReceiptInvoice({ ...valid, ...changed }, p, p.allocations[0]));
});
test("duplicate payment detection catches a matching amount/date despite changed reference/account", () => {
  const p = plan();
  assert.throws(() => assertNoExistingReceipt([{ ...payment(p), Reference: "Jenny entry", Account: { AccountID: id(90) } }], p, p.allocations[0]), /possible existing/);
  assert.throws(() => assertNoExistingReceipt([{ ...payment(p), Amount: 1, Date: "2026-09-01" }], p, p.allocations[0]), /possible existing/);
  assert.doesNotThrow(() => assertNoExistingReceipt([{ ...payment(p), Status: "DELETED" }], p, p.allocations[0]));
});
test("provider readback refuses outgoing, reconciled, altered, missing-currency or mismatched receipts", () => {
  const p = plan(); const valid = payment(p);
  verifyCustomerReceiptReadback(valid, p, p.allocations[0], id(30));
  for (const changed of [{ PaymentType: "ACCPAYPAYMENT" }, { IsReconciled: true }, { Amount: 1 }, { Reference: "other" }, { Account: { AccountID: id(90) } }, { Invoice: { InvoiceID: id(6), Type: "ACCREC" } }, { Date: "2026-09-23" }, { Status: "DELETED" }, { CurrencyRate: 2 }]) assert.throws(() => verifyCustomerReceiptReadback({ ...valid, ...changed }, p, p.allocations[0], id(30)));
  assert.equal(xeroDate("/Date(1790208000000+0000)/"), "2026-09-24");
});

test("successful live-port simulation verifies exact receipts and retains partial invoice balance", async () => {
  const p = plan(); const h = harness(p); const result = await executeCustomerReceipts(p, h.ports);
  assert.equal(result.state, "verified"); assert.equal(result.audit_saved, true); assert.equal(result.reconciliation_performed, false);
  assert.equal(h.writes.length, 2); assert.equal(result.allocations[0].remaining_due_minor, 0); assert.equal(result.allocations[1].remaining_due_minor, 10000);
  assert.equal(h.invoices.get(id(7))!.Status, "AUTHORISED");
  assert.equal(h.authCalls(), 4);
  for (const write of h.writes as { payload: XeroRow; key: string }[]) {
    assert.deepEqual(Object.keys(write.payload).sort(), ["Account", "Amount", "Date", "Invoice", "IsReconciled", "Reference"]);
    assert.equal(write.payload.IsReconciled, false); assert.match(write.key, /^[a-f0-9]{64}$/);
  }
});
for (const phase of ["assertAuthority", "verifySource", "verifyConnection", "getAccount", "getPayments"] as const) {
  test(`preflight failure in ${phase} makes no claim or write`, async () => {
    const h = harness(); h.ports[phase] = async () => { throw new Error(phase); };
    await assert.rejects(executeCustomerReceipts(plan(), h.ports), new RegExp(phase)); assert.equal(h.writes.length, 0); assert.equal(h.claims.size, 0);
  });
}
test("all invoices preflight before any receipt is written", async () => {
  const h = harness(); h.invoices.get(id(7))!.Type = "ACCPAY";
  await assert.rejects(executeCustomerReceipts(plan(), h.ports), /invoice identity/); assert.equal(h.writes.length, 0);
});
test("timeout after claim stops the batch and a fresh invocation cannot issue a second write", async () => {
  const h = harness(); h.ports.createPayment = async payload => { h.writes.push(payload); throw new Error("provider timeout"); };
  const result = await executeCustomerReceipts(plan(), h.ports);
  assert.equal(result.state, "partial"); assert.equal(result.allocations[0].state, "uncertain"); assert.equal(result.allocations[1].state, "not_attempted");
  await assert.rejects(executeCustomerReceipts(plan(), h.ports), /already claimed/); assert.equal(h.writes.length, 1);
});
test("lost response after provider creates receipt leaves uncertainty, never repeats it", async () => {
  const h = harness(); const create = h.ports.createPayment;
  h.ports.createPayment = async (...args) => { await create(...args); throw new Error("response lost"); };
  const result = await executeCustomerReceipts(plan(), h.ports); assert.equal(result.allocations[0].state, "uncertain");
  await assert.rejects(executeCustomerReceipts(plan(), h.ports)); assert.equal(h.writes.length, 1); assert.equal(h.payments.size, 1);
});
test("readback mismatch records known payment ID, stops remaining allocations and never retries", async () => {
  const h = harness(); const get = h.ports.getPayment; h.ports.getPayment = async key => ({ ...await get(key), IsReconciled: true });
  const result = await executeCustomerReceipts(plan(), h.ports);
  assert.equal(result.state, "partial"); assert.equal(result.allocations[0].payment_id, id(30)); assert.equal(result.allocations[0].state, "uncertain"); assert.equal(h.writes.length, 1);
  await assert.rejects(executeCustomerReceipts(plan(), h.ports)); assert.equal(h.writes.length, 1);
});
test("second-write failure preserves the first verified allocation and does not continue", async () => {
  const h = harness(); const create = h.ports.createPayment;
  h.ports.createPayment = async (...args) => { if (h.writes.length === 1) { h.writes.push(args[0]); throw new Error("timeout"); } return create(...args); };
  const result = await executeCustomerReceipts(plan(), h.ports);
  assert.equal(result.state, "partial"); assert.deepEqual(result.allocations.map(line => line.state), ["verified", "uncertain"]); assert.equal(result.allocations[0].payment_id, id(30));
});
test("audit failure before a provider call makes no write, but retains the durable claim", async () => {
  const h = harness(); h.ports.checkpoint = async () => { throw new Error("audit failed"); };
  const result = await executeCustomerReceipts(plan(), h.ports); assert.equal(result.state, "partial"); assert.equal(h.writes.length, 0); assert.ok(h.claims.size > 0);
  await assert.rejects(executeCustomerReceipts(plan(), h.ports), /already claimed/); assert.equal(h.writes.length, 0);
});
test("audit failure after payment response keeps provider ID and makes no next write", async () => {
  const h = harness(); const checkpoint = h.ports.checkpoint;
  h.ports.checkpoint = async (...args) => { if (h.writes.length) throw new Error("audit failed"); await checkpoint(...args); };
  const result = await executeCustomerReceipts(plan(), h.ports); assert.equal(result.state, "partial"); assert.equal(result.allocations[0].payment_id, id(30)); assert.equal(h.writes.length, 1);
});
test("final audit failure preserves every verified provider ID and prohibits repeat creation", async () => {
  const h = harness(); h.ports.finish = async () => { throw new Error("audit failed"); };
  const result = await executeCustomerReceipts(plan(), h.ports); assert.equal(result.state, "partial"); assert.equal(result.audit_saved, false);
  assert.deepEqual(result.allocations.map(line => line.payment_id), [id(30), id(31)]);
  await assert.rejects(executeCustomerReceipts(plan(), h.ports)); assert.equal(h.writes.length, 2);
});
test("approval revoked between allocations stops before the next provider call", async () => {
  const h = harness(); h.ports.assertAuthority = async () => { if (h.writes.length === 1) throw new Error("revoked"); };
  const result = await executeCustomerReceipts(plan(), h.ports); assert.equal(result.state, "partial"); assert.equal(result.allocations[1].state, "not_attempted"); assert.equal(h.writes.length, 1);
});
test("invoice changed after preflight stops before writing", async () => {
  const h = harness(); const get = h.ports.getInvoice;
  h.ports.getInvoice = async key => ({ ...await get(key), ...(h.claims.size ? { AmountDue: 1 } : {}) });
  const result = await executeCustomerReceipts(plan(), h.ports); assert.equal(result.state, "partial"); assert.equal(h.writes.length, 0);
});
test("simultaneous identical requests make at most one set of writes", async () => {
  const h = harness(); const results = await Promise.allSettled([executeCustomerReceipts(plan(), h.ports), executeCustomerReceipts(plan(), h.ports)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1); assert.equal(h.writes.length, 2);
});
