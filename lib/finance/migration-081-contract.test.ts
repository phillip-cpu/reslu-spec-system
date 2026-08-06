import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const migration = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../supabase/migrations/081_finance_recurring_commitments.sql"
  ),
  "utf8"
);

test("recurring commitments use integer cash amounts and explicit recurrence rules", () => {
  assert.match(migration, /create table if not exists finance_recurring_commitments/i);
  assert.match(migration, /amount_minor\s+bigint not null/i);
  assert.match(migration, /'weekly', 'fortnightly', 'monthly', 'quarterly', 'annually'/i);
  assert.match(migration, /end_date\s+date check \(end_date is null or end_date >= first_due_date\)/i);
});

test("writes are capability gated, audited and unavailable as direct table mutations", () => {
  assert.match(migration, /has_finance_capability\('finance\.edit_forecast', null\)/i);
  assert.match(migration, /insert into finance_audit_events/i);
  assert.match(
    migration,
    /revoke insert, update, delete on finance_recurring_commitments from authenticated/i
  );
  assert.match(migration, /p_expected_version <> v_existing\.version/i);
});

test("archiving is a deliberate audited operation", () => {
  assert.match(migration, /create or replace function archive_finance_recurring_commitment/i);
  assert.match(migration, /Archive reason is required/i);
  assert.match(migration, /'recurring_commitment_register', 'archive'/i);
});
