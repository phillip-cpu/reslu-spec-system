import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const sql = readFileSync(
  new URL("../../supabase/migrations/102_xero_readonly.sql", import.meta.url),
  "utf8"
);

test("Xero migration keeps credentials and accounting cache service-role only", () => {
  assert.match(sql, /create table if not exists xero_connections/i);
  assert.match(sql, /access_token_encrypted\s+text not null/i);
  assert.match(sql, /alter table xero_connections enable row level security/i);
  assert.doesNotMatch(sql, /create policy[^;]*xero_connections/i);
});
