import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const migrationName = readdirSync(resolve(root, "supabase/migrations"))
  .find((name) => name.endsWith("_unallocated_supplier_invoices.sql"));
if (!migrationName) throw new Error("Unallocated invoice migration is missing");
const migration = readFileSync(resolve(root, "supabase/migrations", migrationName), "utf8");
const classifierMigrationName = readdirSync(resolve(root, "supabase/migrations"))
  .find((name) => name.endsWith("_classify_unallocated_supplier_invoice.sql"));
if (!classifierMigrationName) throw new Error("Unallocated classification migration is missing");
const classifierMigration = readFileSync(resolve(root, "supabase/migrations", classifierMigrationName), "utf8");
const automation = readFileSync(resolve(root, "lib/stuart/accounts-invoice-automation.ts"), "utf8");
const classifier = readFileSync(resolve(root, "lib/stuart/unallocated-invoices.ts"), "utf8");
const xero = readFileSync(resolve(root, "lib/stuart/xero-draft-bills.ts"), "utf8");
const financeRoute = readFileSync(resolve(root, "app/api/finance/company-invoices/route.ts"), "utf8");
const financePanel = readFileSync(resolve(root, "components/finance/FinanceCompanyInvoicesPanel.tsx"), "utf8");
const mcp = readFileSync(resolve(root, "mcp/src/index.mjs"), "utf8");

test("verified supplier invoices can wait safely without a project or company classification", () => {
  assert.match(migration, /expense_scope = 'unallocated'[\s\S]*project_id is null/);
  assert.match(migration, /idx_invoices_unallocated_queue/);
  assert.match(automation, /expense_scope: projectId \? "project" : "unallocated"/);
  assert.match(automation, /company\/unallocated-invoices/);
  assert.match(automation, /sales\[\\s-\]\*order/);
});

test("later classification requires a human and preserves the Xero draft boundary", () => {
  assert.match(classifier, /input\.humanConfirmed !== true/);
  assert.match(classifier, /classify_unallocated_supplier_invoice/);
  assert.match(classifierMigration, /for update/);
  assert.match(classifierMigration, /insert into public\.finance_audit_events/);
  assert.match(classifierMigration, /revoke all on function[\s\S]*from public, anon, authenticated/);
  assert.match(classifier, /xero_draft_unchanged: true/);
  assert.match(mcp, /classify_stuart_unallocated_invoice/);
});

test("Xero drafts require readable source evidence and an attachment-enabled connection", () => {
  assert.match(xero, /invoice\.source_email_id/);
  assert.match(xero, /accounting\.attachments/);
  assert.match(xero, /attachment_uploaded: true/);
  assert.match(mcp, /process_stuart_supplier_invoice/);
});

test("Finance presents company and unallocated supplier bills together", () => {
  assert.match(financeRoute, /\.in\("expense_scope", \["company", "unallocated"\]\)/);
  assert.match(financePanel, /Unallocated — job or company pending/);
});
