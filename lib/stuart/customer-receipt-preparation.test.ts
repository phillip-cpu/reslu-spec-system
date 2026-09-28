import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { prepareCustomerReceiptPlan, receiptWhereLiteral, validateReceiptPreparation, type ReceiptPreparationInput, type ReceiptPreparationPorts } from "./customer-receipt-preparation.ts";
import { receiptBusinessDate, validateCustomerReceiptPlan, verifiedRemittanceHash } from "./customer-receipt-contract.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function input(): ReceiptPreparationInput {
  return { customer_name: "Test Customer Pty Ltd", account_last_four: "1234", source_email_id: id(1), source_attachment_id: id(2), remittance_reference: "TEST-REMIT", received_on: "2026-09-24", currency: "AUD", received_total_minor: 10000, allocations: [{ invoice_number: "TEST-INV", amount_minor: 10000 }] };
}
function ports(): ReceiptPreparationPorts {
  return {
    getSource: async () => ({ sha256: "a".repeat(64), filename: "test-remittance.pdf" }),
    getTenant: async () => ({ id: id(3), name: "Test Organisation", currency: "AUD" }),
    getContacts: async () => [{ ContactID: id(4), Name: "Test Customer Pty Ltd", ContactStatus: "ACTIVE" }],
    getAccounts: async () => [{ AccountID: id(5), Name: "Test bank", Type: "BANK", Status: "ACTIVE", CurrencyCode: "AUD", BankAccountNumber: "TEST-1234" }],
    getInvoices: async () => [{ InvoiceID: id(6), InvoiceNumber: "TEST-INV", Type: "ACCREC", Status: "AUTHORISED", CurrencyCode: "AUD", Contact: { ContactID: id(4) }, AmountDue: 120, AmountPaid: 30 }],
    getPayments: async () => [],
  };
}
test("preparation resolves IDs/balances but returns false confirmation flags and no approval", async () => {
  const prepared = await prepareCustomerReceiptPlan(input(), ports());
  assert.equal(prepared.state, "prepared_read_only");
  assert.equal(prepared.proposed_plan.tenant_id, id(3)); assert.equal(prepared.proposed_plan.contact_id, id(4)); assert.equal(prepared.proposed_plan.account_id, id(5));
  assert.deepEqual(prepared.proposed_plan.allocations, [{ invoice_id: id(6), invoice_number: "TEST-INV", amount_minor: 10000, expected_due_minor: 12000, expected_paid_minor: 3000 }]);
  assert.equal(prepared.proposed_plan.money_received_confirmed, false); assert.equal(prepared.proposed_plan.source_reviewed_confirmed, false);
  assert.equal("approval_receipt_id" in prepared, false); assert.equal("BankAccountNumber" in prepared.receiving_account, false);
  assert.throws(() => validateCustomerReceiptPlan(prepared.proposed_plan), /human approval/);
});
test("preparation refuses arbitrary fields, duplicate invoice numbers and total mismatch before reading", () => {
  const p = input();
  assert.throws(() => validateReceiptPreparation({ ...p, money_received_confirmed: true }));
  assert.throws(() => validateReceiptPreparation({ ...p, allocations: [p.allocations[0], p.allocations[0]], received_total_minor: 20000 }));
  assert.throws(() => validateReceiptPreparation({ ...p, received_total_minor: 1 }));
});
test("quoted names and invoice numbers remain escaped Xero string literals", () => {
  const malicious = 'x"||ContactID!=Guid("00000000-0000-4000-8000-000000000001")||Name=="x\\';
  assert.equal(receiptWhereLiteral(malicious), 'x\\"||ContactID!=Guid(\\"00000000-0000-4000-8000-000000000001\\")||Name==\\"x\\\\');
  assert.throws(() => validateReceiptPreparation({ ...input(), customer_name: "bad\nname" }));
  assert.throws(() => validateReceiptPreparation({ ...input(), allocations: [{ invoice_number: "bad\rnumber", amount_minor: 10000 }] }));
});
test("ambiguous customer contacts block preparation", async () => {
  const p = ports(); const rows = await p.getContacts(""); p.getContacts = async () => [...rows, { ...rows[0], ContactID: id(99) }];
  await assert.rejects(prepareCustomerReceiptPlan(input(), p), /exactly one/);
});
test("ambiguous receiving-account suffix blocks preparation", async () => {
  const p = ports(); const rows = await p.getAccounts(); p.getAccounts = async () => [...rows, { ...rows[0], AccountID: id(99) }];
  await assert.rejects(prepareCustomerReceiptPlan(input(), p), /ambiguous accounts/);
});
test("foreign base currency, account currency and invoice currency are rejected", async () => {
  const org = ports(); org.getTenant = async () => ({ id: id(3), name: "Test", currency: "USD" });
  await assert.rejects(prepareCustomerReceiptPlan(input(), org), /AUD/);
  const bank = ports(); const accounts = await bank.getAccounts(); bank.getAccounts = async () => [{ ...accounts[0], CurrencyCode: "NZD" }];
  await assert.rejects(prepareCustomerReceiptPlan(input(), bank), /AUD/);
  const inv = ports(); const invoices = await inv.getInvoices("", ""); inv.getInvoices = async () => [{ ...invoices[0], CurrencyCode: "USD" }];
  await assert.rejects(prepareCustomerReceiptPlan(input(), inv), /invoice identity/);
});
test("wrong customer, supplier bill, settled invoice, or ambiguous invoice number are rejected", async () => {
  for (const changed of [{ Contact: { ContactID: id(99) } }, { Type: "ACCPAY" }, { Status: "PAID", AmountDue: 0 }, { InvoiceNumber: "OTHER" }]) {
    const p = ports(); const inv = await p.getInvoices("", ""); p.getInvoices = async () => [{ ...inv[0], ...changed }];
    await assert.rejects(prepareCustomerReceiptPlan(input(), p));
  }
  const p = ports(); const inv = await p.getInvoices("", ""); p.getInvoices = async () => [...inv, ...inv];
  await assert.rejects(prepareCustomerReceiptPlan(input(), p), /one live/);
});
test("unverified/missing source hash cannot produce an executable proposal", async () => {
  const p = ports(); p.getSource = async () => ({ sha256: "invalid", filename: "test.pdf" });
  await assert.rejects(prepareCustomerReceiptPlan(input(), p), /SHA-256/);
});
test("source bytes must be the exact recorded and approved PDF", () => {
  const bytes = Buffer.from("%PDF-1.7\nSynthetic fixture\n"); const hash = createHash("sha256").update(bytes).digest("hex");
  assert.equal(verifiedRemittanceHash(bytes, hash, hash), hash);
  assert.throws(() => verifiedRemittanceHash(Buffer.from("%PDF-1.7\nModified\n"), hash, hash), /fingerprint/);
  assert.throws(() => verifiedRemittanceHash(bytes, hash, "b".repeat(64)), /fingerprint/);
  assert.throws(() => verifiedRemittanceHash(Buffer.from("not a PDF"), hash), /PDF/);
});
test("receipt date uses the Adelaide business day when UTC is still the previous day", () => {
  assert.equal(receiptBusinessDate(new Date("2026-09-28T23:00:00Z")), "2026-09-29");
});
test("pre-existing receipt stops preparation even with a different reference", async () => {
  const p = ports(); p.getPayments = async () => [{ PaymentID: id(9), Invoice: { InvoiceID: id(6) }, Status: "AUTHORISED", PaymentType: "ACCRECPAYMENT", Date: "2026-09-24", Amount: 100, Reference: "Manually entered" }];
  await assert.rejects(prepareCustomerReceiptPlan(input(), p), /possible existing/);
});
test("source/server boundary is read-only and verifies PDF bytes rather than trusting stored metadata", () => {
  const adapter = readFileSync(new URL("./xero-customer-receipts-prepare.ts", import.meta.url), "utf8");
  const source = readFileSync(new URL("./xero-customer-receipt-source.ts", import.meta.url), "utf8");
  assert.doesNotMatch(adapter + source, /xeroPut|xeroPost|\.insert\(|\.update\(\{/);
  assert.match(source, /verifiedRemittanceHash\(bytes, attachment\.content_sha256, expectedHash\)/);
  assert.match(source, /ingested_mailboxes/); assert.match(source, /accounts@reslu\.com\.au/);
  assert.match(adapter, /STUART_XERO_CUSTOMER_RECEIPTS_ENABLED !== "true"/); assert.match(adapter, /auth_profile_id", actorId/);
  assert.match(adapter, /receiptWhereLiteral\(number\)/); assert.match(adapter, /receiptWhereLiteral\(name\)/);
});
test("only the explicit Payments PUT exists; payment scope activation is absent", () => {
  const server = readFileSync(new URL("./xero-customer-receipts.ts", import.meta.url), "utf8");
  const oauth = readFileSync(new URL("../xero/oauth.ts", import.meta.url), "utf8");
  const route = readFileSync(new URL("../../app/api/stuart/xero-customer-receipts/route.ts", import.meta.url), "utf8");
  assert.match(server, /xeroPutJson<.*>\(connection, "api\.xro\/2\.0\/Payments", \{ Payments: \[payload\] \}, idempotencyKey\)/);
  assert.doesNotMatch(server, /xeroPost|xeroPutBytes|\.delete\(/); assert.doesNotMatch(oauth, /"accounting\.payments"\s*,/);
  assert.match(route, /return NextResponse\.json\(result\)/);
});
