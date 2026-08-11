import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sql = readFileSync(
  new URL("../../supabase/migrations/105_xero_finance_actuals.sql", import.meta.url),
  "utf8"
).toLowerCase();

test("Xero cash snapshots remain service-role-only and classify credit accounts", () => {
  assert.match(sql, /create table if not exists xero_bank_accounts/);
  assert.match(sql, /bank_account_type\s+text/);
  assert.match(sql, /create table if not exists xero_cash_snapshots/);
  assert.match(sql, /cash_balance\s+numeric\(14,2\) not null/);
  assert.match(sql, /credit_balance\s+numeric\(14,2\) not null/);
  assert.match(sql, /alter table xero_cash_snapshots enable row level security/);
  assert.match(sql, /revoke all on table xero_cash_snapshots from public, anon, authenticated/);
  assert.match(sql, /grant all on table xero_cash_snapshots to service_role/);
});
