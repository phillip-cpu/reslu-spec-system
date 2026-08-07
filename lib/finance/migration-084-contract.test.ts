import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const migration = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../supabase/migrations/084_link_contract_claims_to_program.sql"
  ),
  "utf8"
);

test("contract claims support contract, program and manual timing", () => {
  assert.match(migration, /add column if not exists trigger_type text not null default 'manual'/i);
  assert.match(migration, /'contract_signed', 'schedule_phase', 'manual'/i);
});

test("program links are real foreign keys and do not copy phase dates", () => {
  assert.match(migration, /foreign key \(schedule_phase_id\)[\s\S]*references schedule_phases\(id\)/i);
  assert.match(migration, /on delete set null/i);
});

test("existing deposit stages become contract-signing claims", () => {
  assert.match(migration, /lower\(trim\(label\)\) like 'deposit%'/i);
  assert.match(migration, /set trigger_type = 'contract_signed'/i);
});
