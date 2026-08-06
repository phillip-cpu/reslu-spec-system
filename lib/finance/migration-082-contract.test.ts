import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const migration = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../supabase/migrations/082_project_commercial_stage.sql"
  ),
  "utf8"
);

test("project stage is explicit and constrained independently of archive status", () => {
  assert.match(migration, /add column if not exists project_stage text not null default 'design'/i);
  assert.match(migration, /'design',[\s\S]*'quoting',[\s\S]*'construction',[\s\S]*'handover'/i);
});

test("signed contract evidence extends the existing billing source of truth", () => {
  assert.match(migration, /alter table client_billing_profiles[\s\S]*contract_reference text/i);
  assert.match(migration, /alter table client_billing_profiles[\s\S]*contract_signed_at date/i);
});

test("existing construction billing profiles backfill construction stage", () => {
  assert.match(migration, /billing\.contract_type = 'construction'/i);
  assert.match(migration, /set project_stage = 'construction'/i);
});
