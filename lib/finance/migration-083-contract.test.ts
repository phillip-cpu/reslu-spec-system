import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const migration = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../supabase/migrations/083_finance_pgcrypto_search_path.sql"
  ),
  "utf8"
);

test("finance hashing resolves pgcrypto from Supabase's extensions schema", () => {
  assert.match(migration, /create extension if not exists pgcrypto with schema extensions/i);
  assert.match(
    migration,
    /alter function finance_program_watermark\(uuid\)[\s\S]*search_path = public, extensions, pg_temp/i
  );
  assert.match(
    migration,
    /alter function activate_project_finance\([\s\S]*search_path = public, extensions, pg_temp/i
  );
});
