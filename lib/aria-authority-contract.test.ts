import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const migration = readFileSync(resolve(root, "supabase/migrations/20260813233645_aria_authority_and_learning_foundation.sql"), "utf8");
const authorize = readFileSync(resolve(root, "app/api/aria-actions/authorize/route.ts"), "utf8");
const approvals = readFileSync(resolve(root, "app/api/aria-actions/approvals/route.ts"), "utf8");

test("R0 and R1 remain operational while R2 and R3 bind exact authority", () => {
  assert.match(migration, /risk_tier = 'R1'[\s\S]*auth_kind := 'request'/);
  assert.match(migration, /approval\.payload_sha256 <> p_payload_sha256/);
  assert.match(migration, /approval\.target_id <> p_target_id/);
  assert.match(migration, /approval\.idempotency_key <> p_idempotency_key/);
  assert.match(migration, /domain or security review is missing/);
});

test("approval and outcome evidence are immutable and identity-backed", () => {
  assert.match(migration, /trg_aria_approval_receipts_immutable/);
  assert.match(migration, /trg_aria_action_receipts_immutable/);
  assert.match(migration, /private\.current_profile_is_admin\(\)/);
  assert.match(migration, /private\.current_actor_is_aria\(\)/);
  assert.match(migration, /private\.canonical_jsonb_text\(authority_request->'tool_args'\)/);
  assert.match(migration, /approval_receipt_id = receipt\.id/);
  assert.doesNotMatch(migration, /user_metadata/);
});

test("API computes exact payload hashes instead of trusting agent input", () => {
  assert.match(authorize, /payloadSha256\(toolArgs\)/);
  assert.match(approvals, /payloadSha256\(toolArgs\)/);
  assert.match(authorize, /deriveActionTarget\(body\.tool_name, toolArgs, authority\)/);
});

test("learning promotion separates Aria staging from accountable human review", () => {
  assert.match(migration, /create_aria_learning_candidate/);
  assert.match(migration, /record_aria_learning_eval/);
  assert.match(migration, /if auth\.uid\(\) is null or not private\.current_profile_is_admin\(\)/);
  assert.match(migration, /stage_aria_learning_candidate/);
  assert.match(migration, /source\.authority_tier = 'T4'/);
  assert.match(migration, /release_aria_learning_candidate[\s\S]*if auth\.uid\(\) is null or not private\.current_profile_is_admin\(\)/);
  assert.match(migration, /release-grade evaluation is incomplete/);
});
