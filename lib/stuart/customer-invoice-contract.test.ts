import assert from "node:assert/strict";
import test from "node:test";
import { CUSTOMER_INVOICE_TOOL, customerInvoiceKey, customerInvoicePayload, prepareCustomerInvoice, validateCustomerInvoice, validateCustomerInvoiceApproval, verifyCustomerInvoiceReadback } from "./customer-invoice-contract.ts";
import { payloadSha256 } from "../aria-authority.ts";
const sample = { source_attachment_id: "a68c1024-c04c-4cad-96fe-74e4921adda3", source_sha256: "a".repeat(64), contact_id: "a68c1024-c04c-4cad-96fe-74e4921adda4", invoice_number: "TEST-1252", issuer_name: "Test issuer", customer_name: "Test customer", invoice_date: "2026-09-05", due_date: "2026-09-10", currency: "AUD", reference: "Synthetic test only", subtotal_ex_gst: 100, gst: 10, total_inc_gst: 110, lines: [{ description: "Test line", amount_ex_gst: 100, gst: 10, account_code: "200", tax_type: "OUTPUT" }] };
test("customer invoices can only produce DRAFT ACCREC with exact dates, tax and source lines", () => {
  const input = validateCustomerInvoice(sample); const payload = customerInvoicePayload(input);
  assert.equal(payload.Type, "ACCREC"); assert.equal(payload.Status, "DRAFT"); assert.equal(payload.DueDate, "2026-09-10"); assert.equal(payload.LineItems[0].TaxAmount, 10);
  assert.equal(customerInvoiceKey("00001252"), "xero-customer-invoice:00001252");
});
test("unconfirmed or unissued invoices do not receive automatic reconciliation", () => {
  assert.throws(() => validateCustomerInvoice({ ...sample, subtotal_ex_gst: 29674.55, gst: 2967.46, total_inc_gst: 32642.01, lines: [{ ...sample.lines[0], amount_ex_gst: 29674.54, gst: 2967.46 }] }), /disagree/);
});
test("the issued invoice total and GST win; the reported one-cent net difference is audited without mutating the source", () => {
  const source = { ...sample, issued_to_client: true, subtotal_ex_gst: 29674.55, gst: 2967.46, total_inc_gst: 32642.01, lines: [{ ...sample.lines[0], amount_ex_gst: 29674.54, gst: 2967.46 }] };
  const original = structuredClone(source);
  const { input, reconciliation } = prepareCustomerInvoice(source);
  assert.deepEqual(source, original);
  assert.equal(input.total_inc_gst, 32642.01);
  assert.equal(input.gst, 2967.46);
  assert.equal(input.lines[0].amount_ex_gst, 29674.55);
  assert.equal(input.lines[0].gst, 2967.46);
  assert.equal(input.lines.length, 1);
  assert.equal(reconciliation?.adjustment_ex_gst, 0.01);
  assert.equal(reconciliation?.source_line_amount_ex_gst, 29674.54);
  assert.equal(reconciliation?.resulting_line_amount_ex_gst, 29674.55);
  const payload = customerInvoicePayload(input);
  assert.equal(payload.Status, "DRAFT");
  assert.doesNotThrow(() => verifyCustomerInvoiceReadback({ ...payload, SubTotal: 29674.55, TotalTax: 2967.46, Total: 32642.01 }, input));
  assert.equal(prepareCustomerInvoice(input).reconciliation, null);
});
test("one-cent decreases and header-only reconciliation preserve GST and select a stable existing line", () => {
  const source = { ...sample, issued_to_client: true, subtotal_ex_gst: 100.01, lines: [{ ...sample.lines[0], amount_ex_gst: 30, gst: 3 }, { ...sample.lines[0], amount_ex_gst: 70.01, gst: 7 }] };
  const result = prepareCustomerInvoice(source);
  assert.equal(result.input.lines[1].amount_ex_gst, 70);
  assert.equal(result.reconciliation?.line_index, 1);
  assert.equal(result.reconciliation?.adjustment_ex_gst, -0.01);
  assert.deepEqual(result.input.lines.map(line => line.gst), [3, 7]);
  const headerOnly = prepareCustomerInvoice({ ...sample, issued_to_client: true, subtotal_ex_gst: 99.99 });
  assert.equal(headerOnly.input.subtotal_ex_gst, 100);
  assert.equal(headerOnly.reconciliation?.line_index, null);
  assert.equal(headerOnly.reconciliation?.adjustment_ex_gst, 0);
  const tied = prepareCustomerInvoice({ ...sample, issued_to_client: true, subtotal_ex_gst: 99.99, total_inc_gst: 109.99, lines: [{ ...sample.lines[0], amount_ex_gst: 50, gst: 5 }, { ...sample.lines[0], amount_ex_gst: 50, gst: 5 }] });
  assert.equal(tied.reconciliation?.line_index, 0);
});
test("issued status cannot excuse larger, tax, malformed, sub-cent or unsafe-line discrepancies", () => {
  for (const delta of [
    { total_inc_gst: 110.02 }, { subtotal_ex_gst: 99.98 }, { gst: 10.01 },
    { issued_to_client: "true" }, { issued_to_client: false, total_inc_gst: 110.01 },
    { total_inc_gst: 110.001 }, { gst: -1 },
    { subtotal_ex_gst: 99.99, lines: [{ ...sample.lines[0], amount_ex_gst: 100.01 }] },
    { subtotal_ex_gst: 0, total_inc_gst: 10.01, lines: [{ ...sample.lines[0], amount_ex_gst: 0 }] },
  ]) assert.throws(() => prepareCustomerInvoice({ ...sample, issued_to_client: true, ...delta }));
});
test("issued reconciliation stays within one cent over many integer-cent inputs without changing tax or source", () => {
  for (let net = 1; net < 400; net += 13) for (const delta of [-1, 1]) {
    const source = { ...sample, issued_to_client: true, subtotal_ex_gst: net / 100, gst: 0.1, total_inc_gst: (net + delta + 10) / 100, lines: [{ ...sample.lines[0], amount_ex_gst: net / 100, gst: 0.1 }] };
    const result = prepareCustomerInvoice(source);
    assert.equal(Math.round(result.input.lines[0].amount_ex_gst * 100), net + delta);
    assert.equal(result.input.gst, source.gst);
    assert.equal(result.input.total_inc_gst, source.total_inc_gst);
    assert.equal(source.lines[0].amount_ex_gst, net / 100);
    assert.equal(result.reconciliation?.adjustment_ex_gst, delta / 100);
  }
});
test("exact approval remains bound to original source figures and issued confirmation, not only the reconciled output", () => {
  const raw = { ...sample, issued_to_client: true, total_inc_gst: 110.01 };
  const { input } = prepareCustomerInvoice(raw);
  assert.notEqual(payloadSha256(raw), payloadSha256(input));
  assert.notEqual(payloadSha256(raw), payloadSha256({ ...raw, issued_to_client: false }));
  const authority = { approval_receipt_id: "receipt", idempotency_key: customerInvoiceKey(raw.invoice_number), expected_absent: true };
  const now = Date.parse("2026-09-08T08:00:00Z");
  const receipt = { id: "receipt", tool_name: CUSTOMER_INVOICE_TOOL, tenant_id: "reslu", target_type: "customer_invoice", target_id: raw.invoice_number, payload_sha256: payloadSha256(raw), approved_by: "owner", idempotency_key: authority.idempotency_key, expires_at: "2026-09-08T08:15:00Z" };
  assert.doesNotThrow(() => validateCustomerInvoiceApproval(receipt, payloadSha256(raw), raw.invoice_number, authority, now));
  assert.throws(() => validateCustomerInvoiceApproval(receipt, payloadSha256(input), raw.invoice_number, authority, now));
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
