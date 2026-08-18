import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const migration = read("supabase/migrations/20260818111114_recover_abandoned_health_diagnostics.sql");
const fixture = read("supabase/fixtures/20260818111114_recover_abandoned_health_diagnostics_verify.sql");
const pendingRoute = read("app/api/health/diagnostics/pending/route.ts");
const heartbeat = read("scripts/reslu-health/heartbeat.sh");
const diagnostics = read("scripts/reslu-health/diagnostics-loop.sh");
const tokenHelper = read("scripts/reslu-health/get-aria-token.sh");

test("diagnostic claims are service-only, atomic and terminally recover abandoned work", () => {
  assert.match(migration, /for update skip locked/i);
  assert.match(migration, /interval '10 minutes'/i);
  assert.match(migration, /status = 'failed'/i);
  assert.match(migration, /never retries or replays/i);
  assert.match(migration, /revoke all[\s\S]*authenticated/i);
  assert.match(migration, /grant execute[\s\S]*service_role/i);
  assert.match(pendingRoute, /rpc\([\s\S]*claim_pending_health_diagnostics/);
  assert.doesNotMatch(pendingRoute, /\.from\("health_diagnostics"\)[\s\S]*\.update/);
});

test("every Mac health network call has a finite connection and total timeout", () => {
  for (const script of [heartbeat, diagnostics, tokenHelper]) {
    assert.match(script, /--connect-timeout 8/);
    assert.match(script, /--max-time (20|25)/);
    assert.match(script, /--retry-max-time (20|25)/);
  }
  assert.match(heartbeat, /run_bounded_capture[\s\S]*softwareupdate/);
  assert.match(diagnostics, /run_bounded_capture[\s\S]*verify-whatsapp-session/);
  assert.match(diagnostics, /run_bounded_capture[\s\S]*softwareupdate/);
});

test("rollback verifier covers privilege, stale recovery, fresh preservation and no reclaim", () => {
  assert.match(fixture, /has_function_privilege\('authenticated'/);
  assert.match(fixture, /abandoned diagnostic was not terminally failed/);
  assert.match(fixture, /fresh diagnostic claim was disturbed/);
  assert.match(fixture, /immediate second poll reclaimed work/);
  assert.match(fixture, /rollback;/i);
});
