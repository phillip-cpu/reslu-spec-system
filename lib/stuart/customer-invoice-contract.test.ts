import assert from "node:assert/strict";
import test from "node:test";
import { CUSTOMER_INVOICE_TOOL, customerInvoiceKey, customerInvoicePayload, validateCustomerInvoice, validateCustomerInvoiceApproval, verifyCustomerInvoiceReadback } from "./customer-invoice-contract.ts";
const sample = { source_attachment_id: "a68c1024-c04c-4cad-96fe-74e4921adda3", source_sha256: "a".repeat(64), contact_id: "a68c1024-c04c-4cad-96fe-74e4921adda4", invoice_number: "TEST-1252", issuer_name: "Test issuer", customer_name: "Test customer", invoice_date: "2026-09-05", due_date: "2026-09-10", currency: "AUD", reference: "Synthetic test only", subtotal_ex_gst: 100, gst: 10, total_inc_gst: 110, lines: [{ description: "Test line", amount_ex_gst: 100, gst: 10, account_code: "200", tax_type: "OUTPUT" }] };
test("customer invoices can only produce DRAFT ACCREC with exact dates, tax and source lines", () => {
  const input = validateCustomerInvoice(sample); const payload = customerInvoicePayload(input);
  assert.equal(payload.Type, "ACCREC"); assert.equal(payload.Status, "DRAFT"); assert.equal(payload.DueDate, "2026-09-10"); assert.equal(payload.LineItems[0].TaxAmount, 10);
  assert.equal(customerInvoiceKey("00001252"), "xero-customer-invoice:00001252");
});
test("the real reported one-cent discrepancy fails closed instead of inventing a rounding line", () => {
  assert.throws(() => validateCustomerInvoice({ ...sample, subtotal_ex_gst: 29674.55, gst: 2967.46, total_inc_gst: 32642.01, lines: [{ ...sample.lines[0], amount_ex_gst: 29674.54, gst: 2967.46 }] }), /disagree/);
});
test("unverified currency, invalid dates, missing evidence, bad line codes and sub-cent values fail", () => {
  for (const delta of [{ currency: "USD" }, { invoice_date: "2026-02-30" }, { due_date: "2026-09-01" }, { source_sha256: "" }, { contact_id: "unknown" }, { lines: [] }, { total_inc_gst: NaN }, { lines: [{ ...sample.lines[0], amount_ex_gst: 100.001 }] }, { lines: [{ ...sample.lines[0], amount_ex_gst: -100 }] }]) assert.throws(() => validateCustomerInvoice({ ...sample, ...delta }));
});
test("provider readback must match the complete approved draft and cannot be an authorised invoice", () => {
  const input = validateCustomerInvoice(sample);
  const row = { ...customerInvoicePayload(input), SubTotal: 100, TotalTax: 10, Total: 110 };
  assert.doesNotThrow(() => verifyCustomerInvoiceReadback(row, input));
  for (const delta of [{ Type: "ACCPAY" }, { Status: "AUTHORISED" }, { Total: 110.01 }, { DueDate: "2026-09-11" }, { Contact: { ContactID: "other" } }, { LineItems: [] }]) assert.throws(() => verifyCustomerInvoiceReadback({ ...row, ...delta }, input));
});

test("only an unrevoked exact-owner receipt for the same tenant, payload, invoice and key may create a draft", () => {
  const now = Date.parse("2026-09-08T08:00:00Z");
  const authority = { approval_receipt_id: "receipt", idempotency_key: customerInvoiceKey("00001252"), expected_absent: true };
  const receipt = { id: "receipt", tool_name: CUSTOMER_INVOICE_TOOL, tenant_id: "reslu", target_type: "customer_invoice", target_id: "00001252", payload_sha256: "approved-hash", approved_by: "owner", revoked_at: null, idempotency_key: customerInvoiceKey("00001252"), expires_at: "2026-09-08T08:15:00Z" };
  assert.doesNotThrow(() => validateCustomerInvoiceApproval(receipt, "approved-hash", "00001252", authority, now));
  for (const delta of [{ tool_name: "create_stuart_xero_draft_bill" }, { tenant_id: "other" }, { payload_sha256: "changed" }, { target_type: "invoice" }, { target_id: "another" }, { approved_by: null }, { revoked_at: "2026-09-08" }, { idempotency_key: "another-attempt" }, { expires_at: "2026-09-08T07:00:00Z" }, { expires_at: "invalid" }]) assert.throws(() => validateCustomerInvoiceApproval({ ...receipt, ...delta }, "approved-hash", "00001252", authority, now));
  assert.throws(() => validateCustomerInvoiceApproval(receipt, "approved-hash", "00001252", { ...authority, expected_absent: false }, now));
  assert.throws(() => validateCustomerInvoiceApproval(receipt, "approved-hash", "00001252", { ...authority, approval_receipt_id: "another" }, now));
});
