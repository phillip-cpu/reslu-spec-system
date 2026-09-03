import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sql = readFileSync(
  new URL("../supabase/migrations/20260903013000_quote_email_address_book_contacts.sql", import.meta.url),
  "utf8",
);

test("automatic supplier contacts are restricted to the service role", () => {
  assert.match(sql, /security definer/i);
  assert.match(sql, /revoke all on function public\.ensure_supplier_quote_contact\(text, text, text\) from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.ensure_supplier_quote_contact\(text, text, text\) to service_role/i);
});

test("automatic supplier contacts reject internal addresses and deduplicate under a transaction lock", () => {
  assert.match(sql, /Internal RESLU addresses cannot be added as supplier contacts/i);
  assert.match(sql, /pg_advisory_xact_lock/i);
  assert.match(sql, /lower\(trim\(email\)\) = v_email/i);
});

test("automatic supplier contacts preserve existing details and record their origin", () => {
  assert.match(sql, /coalesce\(nullif\(trim\(specialty\), ''\)/i);
  assert.match(sql, /Automatically added from a matched outgoing supplier quote email/i);
});
