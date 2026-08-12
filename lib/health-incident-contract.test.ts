import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(path, "utf8");

const healthRoute = read("app/api/health/check/route.ts");
const channelRoute = read("app/api/health/channel-status/route.ts");
const push = read("lib/push.ts");
const migration = read("supabase/migrations/101_health_incident_state.sql");
const verifier = read("supabase/fixtures/101_health_incident_state_verify.sql");

test("channel silence follows monitor reports rather than quiet customer traffic", () => {
  assert.match(healthRoute, /select\("channel,label,status,session_valid,note,updated_at"\)/);
  assert.match(healthRoute, /channelReportIsSilent\(ch\.updated_at/);
  assert.match(healthRoute, /channelReportSilenceThresholdHours\(ch\.channel\)/);
  assert.doesNotMatch(healthRoute, /ageHours.*lastActivity/);
  assert.match(healthRoute, /Channel monitor silent/);
  assert.match(healthRoute, /explicitlyUnhealthy/);
});

test("the conversation bridge has a fast silence threshold and visible report age", () => {
  const health = read("lib/health.ts");
  const channelsCard = read("components/health/ChannelsCard.tsx");
  assert.match(health, /CONVERSATION_BRIDGE_SILENCE_INCIDENT_MINUTES = 5/);
  assert.match(health, /channel === "reslu_conversation_bridge"/);
  assert.match(channelsCard, /Health report:/);
  assert.match(channelsCard, /ch\.updated_at/);
});

test("routine status reports preserve last real inbound and outbound timestamps", () => {
  assert.match(channelRoute, /body\.last_inbound_at !== undefined/);
  assert.match(channelRoute, /body\.last_outbound_at !== undefined/);
  assert.doesNotMatch(channelRoute, /last_inbound_at: body\.last_inbound_at \?\? null/);
});

test("incident dedupe is atomic and independent from notification read state", () => {
  assert.match(push, /rpc\("open_health_incident"/);
  assert.match(push, /rpc\("resolve_health_incident"/);
  assert.doesNotMatch(push, /\.from\("notifications"\)[\s\S]{0,180}\.is\("read_at", null\)/);
  assert.match(migration, /create table if not exists health_incidents/);
  assert.match(migration, /on conflict \(kind\) do update/);
  assert.match(migration, /where health_incidents\.resolved_at is not null/);
  assert.match(migration, /revoke all on table health_incidents from public, anon, authenticated/);
  assert.match(verifier, /reading a notification reopened the incident/);
  assert.match(verifier, /rollback;/);
});
