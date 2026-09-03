import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  new URL("../supabase/migrations/20260903000050_email_thread_identity.sql", import.meta.url),
  "utf8"
);

test("supplier email links use mailbox-scoped Gmail thread identities", () => {
  assert.match(migration, /gmail_thread_refs jsonb not null/i);
  assert.match(migration, /new\.gmail_thread_refs\s*->>\s*lower\(request\.provider_mailbox\)\s*=\s*request\.provider_thread_id/i);
  assert.match(migration, /update of thread_id, gmail_thread_refs, triage_label/i);
});

test("selecting a quote is atomic and refuses incomplete allocations", () => {
  assert.match(migration, /create or replace function public\.select_supplier_quote/i);
  assert.match(migration, /amount_ex_gst is null/i);
  assert.match(migration, /allocate an ex GST amount to every estimate line/i);
  assert.match(migration, /update public\.cost_lines/i);
  assert.match(migration, /update public\.supplier_quote_packages/i);
});

test("existing email import validates project lines and attaches the complete thread", () => {
  assert.match(migration, /create or replace function public\.import_supplier_quote_thread/i);
  assert.match(migration, /project_id = p_project_id/i);
  assert.match(migration, /gmail_thread_refs\s*->>\s*v_provider_mailbox\s*=\s*v_provider_thread_id/i);
  assert.match(migration, /insert into public\.supplier_quote_request_emails/i);
});
