import assert from "node:assert/strict";
import test from "node:test";
import { applyXeroInvoiceActuals } from "./xero-actuals.ts";

test("Xero sales invoice replaces matching RESLU claim actuals", () => {
  const result = applyXeroInvoiceActuals({
    contributions: [{
      contributionKey: "claim:1",
      direction: "inflow",
      description: "Client claim",
      plannedMinor: 150_000,
      sourceTrace: { client_invoice_id: "internal-1" },
    }],
    clientInvoices: [{ id: "internal-1", invoice_number: "INV-0042" } as never],
    xeroInvoices: [{
      xero_invoice_id: "xero-1",
      invoice_type: "ACCREC",
      status: "AUTHORISED",
      invoice_number: "INV 0042",
      contact_name: "Client",
      invoice_date: "2026-08-01",
      due_date: "2026-08-15",
      total: 1500,
      amount_paid: 500,
      amount_credited: 0,
    }],
    xeroPayments: [{ xero_invoice_id: "xero-1", payment_date: "2026-08-10", status: "AUTHORISED" }],
  });

  assert.equal(result.contributions.length, 1);
  assert.equal(result.contributions[0].actualAccruedMinor, 150_000);
  assert.equal(result.contributions[0].actualPaidMinor, 50_000);
  assert.equal(result.matchedClientInvoices, 1);
  assert.equal(result.unmatchedInvoices, 0);
});

test("unmatched authorised Xero supplier bill is an explicit outflow", () => {
  const result = applyXeroInvoiceActuals({
    contributions: [],
    clientInvoices: [],
    xeroInvoices: [{
      xero_invoice_id: "bill-1",
      invoice_type: "ACCPAY",
      status: "AUTHORISED",
      invoice_number: "SUP-7",
      contact_name: "Supplier",
      invoice_date: "2026-08-01",
      due_date: "2026-08-20",
      total: 110,
      amount_paid: 0,
      amount_credited: 0,
    }],
    xeroPayments: [],
  });

  assert.equal(result.contributions[0].direction, "outflow");
  assert.equal(result.contributions[0].actualAccruedMinor, 11_000);
  assert.equal(result.unmatchedInvoices, 1);
});
