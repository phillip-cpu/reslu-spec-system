import assert from "node:assert/strict";
import test from "node:test";
import { buildSupplierQuoteEmail, extractPromisedQuoteDate, quoteRequestFollowup } from "./supplier-quotes.ts";

test("extracts common Australian supplier turnaround replies", () => {
  assert.equal(extractPromisedQuoteDate("We can have this back by 4 September.", "2026-08-28T03:00:00Z"), "2026-09-04");
  assert.equal(extractPromisedQuoteDate("Allow 3 business days please", "2026-08-28T03:00:00Z"), "2026-09-02");
  assert.equal(extractPromisedQuoteDate("I'll send it tomorrow", "2026-08-28T03:00:00Z"), "2026-08-29");
});

test("follow-up changes from acknowledgement to turnaround to promised quote", () => {
  assert.deepEqual(quoteRequestFollowup({ status: "sent", sent_at: "2026-08-28T00:00:00Z", acknowledgement_due_at: "2026-09-01", acknowledged_at: null, promised_quote_at: null }), { kind: "acknowledgement", due: "2026-09-01" });
  assert.deepEqual(quoteRequestFollowup({ status: "acknowledged", sent_at: "2026-08-28T00:00:00Z", acknowledgement_due_at: "2026-09-01", acknowledged_at: "2026-08-29T00:00:00Z", promised_quote_at: null }), { kind: "turnaround", due: "2026-08-29" });
  assert.deepEqual(quoteRequestFollowup({ status: "acknowledged", sent_at: "2026-08-28T00:00:00Z", acknowledgement_due_at: "2026-09-01", acknowledged_at: "2026-08-29T00:00:00Z", promised_quote_at: "2026-09-04" }), { kind: "quote_due", due: "2026-09-04" });
});

test("request email carries reference, line items, turnaround ask and response link", () => {
  const result = buildSupplierQuoteEmail({ requestReference: "RFQ-123", projectName: "Dale Home", packageTitle: "Windows & Doors", responseUrl: "https://example.com/quote-request/token", lines: [{ description: "Aluminium windows", qty: 8, unit: "ea" }], attachmentNames: ["window-schedule.pdf"] });
  assert.match(result.subject, /RFQ-123/);
  assert.match(result.body, /expected turnaround/i);
  assert.match(result.body, /Aluminium windows/);
  assert.match(result.body, /window-schedule\.pdf/);
});
