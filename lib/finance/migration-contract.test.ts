import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const migration = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../supabase/migrations/080_finance_foundation.sql"
  ),
  "utf8"
);

test("finance migration enforces explicit capabilities and no permissive team_all policy", () => {
  assert.match(migration, /create or replace function has_finance_capability/i);
  assert.match(migration, /create policy project_finance_profiles_select/i);
  assert.doesNotMatch(migration, /create policy\s+"?team_all"?\s+on\s+finance_/i);
  assert.match(
    migration,
    /revoke insert, update, delete on finance_activation_events from authenticated/i
  );
});

test("activation is atomic, idempotent and gated by a published policy", () => {
  assert.match(migration, /create or replace function activate_project_finance/i);
  assert.match(migration, /idempotency_key\s+text not null unique/i);
  assert.match(migration, /p\.status = 'published'/i);
  assert.match(migration, /for update/i);
  assert.match(migration, /Program changed after readiness preview/i);
});

test("published finance facts are immutable and stored in minor units", () => {
  assert.match(migration, /create or replace function prevent_finance_immutable_change/i);
  assert.match(migration, /planned_net_minor\s+bigint/i);
  assert.match(migration, /before update or delete on forecast_baselines/i);
  assert.match(migration, /before update or delete on finance_projection_versions/i);
});

test("the seeded M0 policy cannot publish without all external confirmations", () => {
  assert.match(migration, /create or replace function publish_finance_policy/i);
  assert.match(migration, /Owner, accountant and legal confirmations are required/i);
  assert.match(migration, /M0 draft only\. Must be confirmed and published/i);
});
