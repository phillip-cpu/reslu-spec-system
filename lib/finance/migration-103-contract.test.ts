import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../../supabase/migrations/103_finance_one_time_outgoings.sql", import.meta.url),
  "utf8"
);

test("one-time outgoings migration adds the once frequency", () => {
  assert.match(migration, /'once', 'weekly', 'fortnightly'/);
  assert.match(migration, /finance_recurring_commitments_frequency_check/);
});

test("one-time outgoings migration adds entertainment without dropping marketing", () => {
  assert.match(migration, /'marketing', 'entertainment'/);
  assert.match(migration, /finance_recurring_commitments_category_check/);
});
