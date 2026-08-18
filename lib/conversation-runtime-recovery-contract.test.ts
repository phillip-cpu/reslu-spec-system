import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const migration = read("supabase/migrations/20260818105029_reconcile_stale_conversation_runtime.sql");
const fixture = read("supabase/fixtures/20260818105029_reconcile_stale_conversation_runtime_verify.sql");
const healthRoute = read("app/api/health/check/route.ts");
const health = read("lib/health.ts");

test("runtime watchdog terminates abandoned work without automatic replay", () => {
  assert.match(migration, /status = 'cancelled'[\s\S]*cancellation_requested_at/);
  assert.match(migration, /status = 'failed'[\s\S]*progress_updated_at/);
  assert.doesNotMatch(migration, /set\s+status\s*=\s*'queued'/i);
  assert.match(migration, /Review the task before retrying/);
  assert.match(migration, /revoke all on function reconcile_stale_conversation_runtime\(\) from public, anon, authenticated/i);
  assert.match(migration, /grant execute on function reconcile_stale_conversation_runtime\(\) to service_role/i);
});

test("stale calls drop once, cancel only unfinished conversational output and regain uniqueness", () => {
  assert.match(migration, /status = 'dropped'[\s\S]*stale_active_watchdog/);
  assert.match(migration, /agent_conversation_jobs[\s\S]*status in \('pending', 'processing'\)/);
  assert.match(migration, /kind,[\s\S]*body,[\s\S]*metadata[\s\S]*'call_record'/);
  assert.match(migration, /create unique index if not exists conversation_calls_one_active_per_starter/);
});

test("health cron reconciles before measuring and exposes content-free outcome counts", () => {
  const recoveryPosition = healthRoute.indexOf('.rpc("reconcile_stale_conversation_runtime")');
  const healthPosition = healthRoute.indexOf("computeSpecHealth(service)");
  assert.ok(recoveryPosition > 0 && recoveryPosition < healthPosition);
  assert.match(healthRoute, /runtime_recovery_available: !runtimeRecoveryError/);
  assert.match(healthRoute, /runtime_recovery: runtimeRecoveryError \? null/);
  assert.match(health, /progress_updated_at \?\? task\.updated_at \?\? task\.claimed_at/);
  assert.match(health, /running_tasks_stuck: runningTasksStuck/);
});

test("rollback verifier covers cancellation, failure, fresh progress, late output and idempotency", () => {
  assert.match(fixture, /fresh_status <> 'running'/);
  assert.match(fixture, /job_status <> 'cancelled'/);
  assert.match(fixture, /runtime recovery is not idempotent/i);
  assert.match(fixture, /rollback;/);
});
