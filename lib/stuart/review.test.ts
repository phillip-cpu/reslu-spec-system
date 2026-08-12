import assert from "node:assert/strict";
import test from "node:test";
import { reviewAccountsEmails, reviewSpecAgainstXero, reviewXeroInvoices } from "./review.ts";

const now = "2026-08-12T00:00:00.000Z";

test("separates overdue receivables from payables", () => {
  const findings = reviewXeroInvoices([
    { xero_invoice_id: "r1", invoice_type: "ACCREC", status: "AUTHORISED", invoice_number: "R-1", contact_name: "Client", due_date: "2026-08-01", total: 1000, amount_due: 1000 },
    { xero_invoice_id: "p1", invoice_type: "ACCPAY", status: "AUTHORISED", invoice_number: "P-1", contact_name: "Supplier", due_date: "2026-08-01", total: 500, amount_due: 500 },
  ], "2026-08-12", now);
  assert.deepEqual(findings.map((finding) => finding.kind), ["overdue_receivable", "overdue_payable"]);
});

test("flags Spec invoices missing from Xero and exact-number total conflicts", () => {
  const xero = [{ xero_invoice_id: "x1", invoice_type: "ACCREC" as const, status: "AUTHORISED", invoice_number: "026-01", contact_name: "Client", due_date: null, total: 1100, amount_due: 1100 }];
  const findings = reviewSpecAgainstXero([
    { id: "s1", invoice_number: "026-01", total_inc_gst: 1000, status: "sent" },
    { id: "s2", invoice_number: "026-02", total_inc_gst: 500, status: "sent" },
  ], xero, "ACCREC", now);
  assert.deepEqual(findings.map((finding) => finding.kind).sort(), ["missing_from_xero", "xero_conflict"]);
});

test("quarantines non-finance Aria forwards and creates a controlled coaching rule", () => {
  const result = reviewAccountsEmails([{
    id: "e1", from_addr: "aria@reslu.com.au", subject: "Interesting furniture article",
    clean_text: "Have a look at this design story.", received_at: now, triage_label: null,
    ingested_mailboxes: ["accounts@reslu.com.au"], email_attachments: [],
  }], new Set(), now);
  assert.equal(result.feedback.length, 1);
  assert.match(result.feedback[0].training_rule, /Only forward to Accounts/);
});

test("keeps likely invoice email as a finance exception, not Aria coaching", () => {
  const result = reviewAccountsEmails([{
    id: "e2", from_addr: "aria@reslu.com.au", subject: "Tax invoice INV-2048 $550.00",
    clean_text: "Tax invoice number INV-2048 total $550.00", received_at: now, triage_label: null,
    ingested_mailboxes: ["accounts@reslu.com.au"],
    email_attachments: [{ filename: "invoice-2048.pdf", extracted_text: "Total $550.00" }],
  }], new Set(), now);
  assert.equal(result.feedback.length, 0);
  assert.equal(result.findings[0]?.kind, "unmatched_accounts_email");
});
