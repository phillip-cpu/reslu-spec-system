import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const migration = read("supabase/migrations/104_single_active_conversation_call.sql");
const restoration = read("supabase/migrations/20260818171137_restore_single_active_call_creation.sql");
const fixture = read("supabase/fixtures/104_single_active_conversation_call_verify.sql");

test("migration 104 recovers old active calls before enforcing one active call per person", () => {
  assert.match(migration, /row_number\(\) over[\s\S]*partition by call\.started_by/i);
  assert.match(migration, /started_at < now\(\) - interval '4 hours'/i);
  assert.match(migration, /create unique index if not exists conversation_calls_one_active_per_starter[\s\S]*where status = 'active'/i);
});

test("a new call serializes by profile and truthfully records the superseded call", () => {
  assert.match(migration, /auth\.uid\(\)::text \|\| ':active-conversation-call'/i);
  assert.match(migration, /status = 'dropped'[\s\S]*'superseded_by_new_call'/i);
  assert.match(migration, /kind,[\s\S]*'call_record'/i);
  assert.match(migration, /message\.metadata->>'call_id' = superseded_call\.id::text/i);
});

test("supersession cancels only late consult output and never durable tasks", () => {
  assert.match(migration, /update agent_conversation_jobs job[\s\S]*message\.metadata->>'realtime_call_id' = superseded_call\.id::text/i);
  assert.doesNotMatch(migration, /update\s+agent_tasks/i);
  assert.match(migration, /Durable agent_tasks are deliberately not part of this cancellation/i);
});

test("the latest migration restores profile-scoped supersession after remote function drift", () => {
  assert.match(restoration, /auth\.uid\(\)::text \|\| ':active-conversation-call'/i);
  assert.match(restoration, /status = 'dropped'[\s\S]*'superseded_by_new_call'/i);
  assert.match(restoration, /update agent_conversation_jobs job[\s\S]*message\.metadata->>'realtime_call_id' = superseded_call\.id::text/i);
  assert.match(restoration, /grant execute on function create_conversation_call_idempotent\(uuid, text, uuid\) to authenticated/i);
  assert.doesNotMatch(restoration, /update\s+agent_tasks/i);
});

test("the rollback verifier exercises retry, consult cancellation and durable task survival", () => {
  assert.match(fixture, /retried_call_id <> test\.second_call_id/i);
  assert.match(fixture, /consult_status <> 'cancelled'/i);
  assert.match(fixture, /durable_status <> 'queued'/i);
  assert.match(fixture, /active_count <> 1/i);
  assert.match(fixture, /rollback;/i);
});
