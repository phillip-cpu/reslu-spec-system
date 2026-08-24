import assert from "node:assert/strict";
import test from "node:test";
import { prepareCompanyOverheadIntake } from "./company-overhead-intake.ts";

const nfs = {
  source_email_id: "aeb19c54-5fa9-4a1d-9f60-183d78ea7668",
  source_attachment_id: "cbff69bd-7ea6-4d0e-b21b-e70a9c73b113",
  ingested_mailboxes: ["phillip@reslu.com.au"],
  triage_label: "supplier_invoice",
  matched_project_id: null,
  supplier: "Paul Thompson & TP Pty Ltd (Norwood Financial Services)",
  invoice_date: "12th August 2026",
  amount_ex_gst: 1620,
  gst: 162,
  total: 1782,
  job_hints: "RESLU Developments",
  job_mentions: ["RESLU Developments"],
  subject: "Invoice",
  line_hints: "Profit and Loss Report & Balance Sheet with requirements for QBE",
  attachment_filename: "Invoice - Reslu Developments.pdf",
  attachment_mime: "application/pdf",
};

test("routes the NFS invoice as company overhead and ignores the billed company name", () => {
  const result = prepareCompanyOverheadIntake(nfs);
  assert.equal(result.eligible, true);
  if (!result.eligible) return;
  assert.equal(result.intake.invoice_date, "2026-08-12");
  assert.equal(result.intake.total_minor, 178200);
  assert.equal(result.intake.category, "professional_fees");
  assert.equal(result.intake.project_id, null);
  assert.equal(result.intake.route_to, "accounts@reslu.com.au");
});

test("blocks an invoice with explicit project evidence", () => {
  const result = prepareCompanyOverheadIntake({ ...nfs, job_hints: "Conessa - 5 Central Avenue" });
  assert.equal(result.eligible, false);
  if (!result.eligible) assert.match(result.reason, /project evidence/i);
});

test("blocks amount conflicts", () => {
  const result = prepareCompanyOverheadIntake({ ...nfs, total: 1700 });
  assert.equal(result.eligible, false);
  if (!result.eligible) assert.match(result.reason, /do not reconcile/i);
});

test("blocks foreign currency from the AUD overhead path", () => {
  const result = prepareCompanyOverheadIntake({ ...nfs, currency_code: "USD" });
  assert.equal(result.eligible, false);
  if (!result.eligible) assert.match(result.reason, /foreign-currency/i);
});

test("requires an authorised source mailbox and a PDF", () => {
  assert.equal(prepareCompanyOverheadIntake({ ...nfs, ingested_mailboxes: ["other@reslu.com.au"] }).eligible, false);
  assert.equal(prepareCompanyOverheadIntake({ ...nfs, attachment_mime: "image/png", attachment_filename: "invoice.png" }).eligible, false);
});
