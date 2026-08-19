import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const migration = readFileSync(resolve(root, "supabase/migrations/20260819213843_company_expense_invoices.sql"), "utf8");
const stager = readFileSync(resolve(root, "lib/stuart/company-expense-invoices.ts"), "utf8");
const route = readFileSync(resolve(root, "app/api/stuart/company-expense-invoices/route.ts"), "utf8");
const financeRoute = readFileSync(resolve(root, "app/api/finance/company-invoices/route.ts"), "utf8");
const financePanel = readFileSync(resolve(root, "components/finance/FinanceCompanyInvoicesPanel.tsx"), "utf8");
const mcp = readFileSync(resolve(root, "mcp/src/index.mjs"), "utf8");

test("company invoices are explicit, project-free and linked safely to recurring commitments", () => {
  assert.match(migration, /alter column project_id drop not null/);
  assert.match(migration, /expense_scope = 'company'[\s\S]*project_id is null/);
  assert.match(migration, /recurring_commitment_id uuid[\s\S]*on delete set null/);
  assert.match(migration, /idx_invoices_recurring_commitment/);
  assert.match(migration, /lower\(btrim\(supplier\)\)[\s\S]*lower\(btrim\(invoice_number\)\)/);
});

test("Stuart requires human classification and only stages source-backed Accounts invoices", () => {
  assert.match(stager, /input\.humanConfirmed !== true/);
  assert.match(stager, /Company expense invoices must come from the Accounts mailbox/);
  assert.match(stager, /project_id: null/);
  assert.match(stager, /expense_scope: "company"/);
  assert.match(stager, /source_email_id: input\.emailId/);
  assert.doesNotMatch(stager, /createStuartXeroDraftBill|xeroPostJson|xeroPutBytes/);
  assert.match(route, /body\.human_confirmed !== true/);
  assert.match(mcp, /stage_stuart_company_expense_invoice/);
});

test("Finance exposes company bills only behind the company-finance capability", () => {
  assert.match(financeRoute, /hasFinanceCapability\(supabase, "finance\.view_company"\)/);
  assert.match(financeRoute, /\.eq\("expense_scope", "company"\)/);
  assert.match(financePanel, /Office and recurring bills/);
  assert.match(financePanel, /currency unresolved/);
});
