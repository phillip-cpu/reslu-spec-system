import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const draftSource = readFileSync(new URL("./xero-draft-bills.ts", import.meta.url), "utf8");
const statementSource = readFileSync(new URL("./supplier-statements.ts", import.meta.url), "utf8");
const sourceAttachment = readFileSync(new URL("./source-invoice-attachment.ts", import.meta.url), "utf8");
const mcpSource = readFileSync(new URL("../../mcp/src/index.mjs", import.meta.url), "utf8");
const oauthSource = readFileSync(new URL("../xero/oauth.ts", import.meta.url), "utf8");

test("Stuart creates only draft ACCPAY bills and never payments", () => {
  assert.match(draftSource, /Type: "ACCPAY"/);
  assert.match(draftSource, /Status: "DRAFT"/);
  assert.doesNotMatch(draftSource, /api\.xro\/2\.0\/Payments/);
  assert.doesNotMatch(draftSource, /Status: "AUTHORISED"/);
});

test("draft bill path requires source evidence, exact contacts and idempotency", () => {
  assert.match(draftSource, /original supplier invoice must be attached/i);
  assert.match(draftSource, /exact existing Xero supplier contact/i);
  assert.match(draftSource, /stuart_xero_draft_bills/);
  assert.match(draftSource, /live Xero supplier bill already uses this invoice number/i);
  assert.match(draftSource, /Spec invoice total does not match the attached original/i);
});

test("source invoice attachment is traceable, fingerprinted and does not write to Xero", () => {
  assert.match(sourceAttachment, /attachment\.email_id !== invoice\.source_email_id/);
  assert.match(sourceAttachment, /content fingerprint/i);
  assert.match(sourceAttachment, /storage_path/);
  assert.doesNotMatch(sourceAttachment, /xeroPostJson|xeroPutBytes|api\.xro/);
  assert.match(mcpSource, /attach_stuart_source_invoice/);
});

test("supplier statements reconcile locally and cannot post to Xero", () => {
  assert.match(statementSource, /missing_from_xero/);
  assert.match(statementSource, /total_mismatch/);
  assert.doesNotMatch(statementSource, /xeroPostJson|xeroPutBytes/);
  assert.match(mcpSource, /Never create a bill from a statement total/);
});

test("OAuth requests invoice and attachment writes but payment reads only", () => {
  assert.match(oauthSource, /"accounting\.invoices"/);
  assert.match(oauthSource, /"accounting\.attachments"/);
  assert.match(oauthSource, /"accounting\.payments\.read"/);
  assert.doesNotMatch(oauthSource, /"accounting\.payments"\s*,/);
});
