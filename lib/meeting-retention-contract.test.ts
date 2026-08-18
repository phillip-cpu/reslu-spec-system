import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

test("meeting retention policy is inert, RLS-protected and service-mutated", () => {
  const migration = read("supabase/migrations/20260818182301_meeting_source_retention_policy.sql");
  assert.match(migration, /enabled\s+boolean not null default false/i);
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /revoke all on meeting_source_retention_policy from public, anon, authenticated/i);
  assert.match(migration, /grant select on meeting_source_retention_policy to authenticated/i);
  assert.match(migration, /security invoker/gi);
  assert.match(migration, /role = 'admin'/i);
  assert.match(migration, /grant execute on function set_meeting_source_retention_policy[\s\S]*to service_role/i);
  assert.match(migration, /Existing proposed dates remain unchanged/i);
});

test("retention finalization is due-only, terminal-only, audited and idempotent", () => {
  const migration = read("supabase/migrations/20260818182301_meeting_source_retention_policy.sql");
  assert.match(migration, /recording_retain_until <= now\(\)/i);
  assert.match(migration, /transcript_retain_until <= now\(\)/i);
  assert.match(migration, /status in \('review','filed','discarded','failed'\)/i);
  assert.match(migration, /if v_changed_id is null then[\s\S]*return false/i);
  assert.match(migration, /'retention_purged'/i);
  assert.match(migration, /revoke execute on function finalize_meeting_source_retention_purge[\s\S]*authenticated/i);
});

test("admin API requires explicit activation and reports exact eligible counts", () => {
  const route = read("app/api/settings/meeting-retention/route.ts");
  const validation = read("lib/meeting-retention.ts");
  assert.match(route, /info\.role !== "admin"/);
  assert.match(route, /count: "exact", head: true/g);
  assert.match(route, /set_meeting_source_retention_policy/);
  assert.match(validation, /ENABLE AUTOMATIC DELETION/);
  assert.match(validation, /source\.confirmation !== MEETING_RETENTION_ENABLE_CONFIRMATION/);
});

test("daily purge is secret-gated, policy-gated, bounded and observable", () => {
  const route = read("app/api/meeting-retention/purge/route.ts");
  const vercel = read("vercel.json");
  assert.match(route, /Bearer \$\{cronSecret\}/);
  assert.match(route, /if \(!policy\?\.enabled\)/);
  assert.match(route, /RECORDING_BATCH_SIZE = 25/);
  assert.match(route, /TRANSCRIPT_BATCH_SIZE = 100/);
  assert.ok(route.indexOf(".remove([source.recording_storage_path])") < route.indexOf("p_kind: \"recording\""));
  assert.match(route, /recordJobRun/);
  assert.match(vercel, /\/api\/meeting-retention\/purge/);
});

test("settings communicates scope and requires a human enable action", () => {
  const component = read("components/settings/MeetingRetentionSettings.tsx");
  const page = read("app/(dashboard)/settings/page.tsx");
  assert.match(component, /Filed meeting summaries, decisions, actions and links remain canonical/);
  assert.match(component, /Eligible at the next daily run if enabled/);
  assert.match(component, /Enable irreversible automatic deletion/);
  assert.match(component, /Approve &amp; enable/);
  assert.match(page, /MeetingRetentionSettings/);
});

test("production verifier proves grants, configured dates and idempotent source scrubbing", () => {
  const fixture = read("supabase/fixtures/20260818182301_meeting_source_retention_policy_verify.sql");
  assert.match(fixture, /has_table_privilege\('anon'/);
  assert.match(fixture, /set_meeting_source_retention_policy\(20, 400, true/);
  assert.match(fixture, /v_started_at \+ interval '20 days'/);
  assert.match(fixture, /v_started_at \+ interval '400 days'/);
  assert.match(fixture, /purge finalization was not idempotent/i);
  assert.match(fixture, /all test changes rolled back/i);
});
