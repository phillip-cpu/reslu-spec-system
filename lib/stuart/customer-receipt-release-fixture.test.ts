import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { payloadSha256 } from "../aria-authority.ts";
import { validateCustomerReceiptPlan } from "./customer-receipt-contract.ts";

test("rollback SQL fixture uses the exact current receipt contract and JavaScript approval hash", () => {
  const sql = readFileSync(new URL("../../supabase/fixtures/stuart_customer_receipts_release_verify.sql", import.meta.url), "utf8");
  const fixture = JSON.parse(sql.match(/\$payload\$(.*?)\$payload\$/s)![1]);
  validateCustomerReceiptPlan(fixture, "2026-09-28");
  const expected = sql.match(/payload_hash text := '([a-f0-9]{64})'/)![1];
  assert.equal(payloadSha256(fixture), expected);
  assert.match(sql, /create temporary table receipt_review_runs\s+\(like public\.aria_action_runs including all\)/);
  assert.doesNotMatch(sql, /(?:insert into|update|delete from)\s+(?:public\.)?aria_/i);
  assert.match(sql.trim(), /rollback;$/i);
});
