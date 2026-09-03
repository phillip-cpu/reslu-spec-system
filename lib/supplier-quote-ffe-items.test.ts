import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  new URL("../supabase/migrations/20260903011000_supplier_quote_ffe_items.sql", import.meta.url),
  "utf8"
);

test("quote packages keep direct FF&E items and per-item responses", () => {
  assert.match(migration, /create table if not exists public\.supplier_quote_package_items/i);
  assert.match(migration, /create table if not exists public\.supplier_quote_response_items/i);
  assert.match(migration, /create table if not exists public\.supplier_quote_email_match_items/i);
  assert.match(migration, /cost_scope\s*<>\s*'trade_package'/i);
});

test("selecting an FF&E quote writes a unit trade price and supplier identity", () => {
  assert.match(migration, /update public\.items item/i);
  assert.match(migration, /set price_trade\s*=\s*round/i);
  assert.match(migration, /supplier_contact_id\s*=\s*selected_request\.contact_id/i);
  assert.match(migration, /supplier_email\s*=\s*coalesce/i);
});

test("email import validates both estimate lines and direct FF&E items", () => {
  assert.match(migration, /p_item_ids uuid\[\]/i);
  assert.match(migration, /At least one estimate line or direct FF&E item is required/i);
  assert.match(migration, /One or more FF&E items are invalid or included in a trade package/i);
  assert.match(migration, /insert into public\.supplier_quote_package_items/i);
});
