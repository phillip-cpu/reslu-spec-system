import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

test("specialist consultation has one owner, one other specialist and an exact audit trail", () => {
  const migration = read("supabase/migrations/116_conversation_agent_consultations.sql");
  assert.match(migration, /owner_agent_id <> specialist_agent_id/);
  assert.match(migration, /unique \(conversation_id, realtime_tool_call_id\)/);
  assert.match(migration, /owner_agent_slug/);
  assert.match(migration, /consulted_agent_slug/);
  assert.match(migration, /members_read_agent_consultations/);
  assert.match(migration, /grant execute on function complete_conversation_agent_consultation[\s\S]*to service_role/);
  assert.doesNotMatch(migration, /grant execute on function complete_conversation_agent_consultation[\s\S]*to authenticated/);
});

test("specialist queueing is atomic, active-call scoped and exactly once", () => {
  const migration = read("supabase/migrations/116_conversation_agent_consultations.sql");
  assert.match(migration, /call\.status = 'active'/);
  assert.match(migration, /insert into conversation_messages[\s\S]*insert into agent_conversation_jobs[\s\S]*insert into conversation_agent_consultations/i);
  assert.match(migration, /specialist consultation idempotency key conflict/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /completion raced cancellation/);
  assert.match(migration, /response_message_id/);
});

test("Realtime exposes a dedicated bounded specialist tool and keeps durable work separate", () => {
  const voice = read("lib/realtime-voice.ts");
  const workspace = read("components/conversations/ConversationWorkspace.tsx");
  assert.match(voice, /name: "consult_reslu_specialist"/);
  assert.match(voice, /bounded second opinion/);
  assert.match(voice, /must not perform consequential actions or start durable work/);
  assert.match(workspace, /event\.name === "consult_reslu_specialist"/);
  assert.match(workspace, /realtime\/\$\{endpoint\}/);
  assert.match(workspace, /Consulted \{message\.metadata\.consulted_agent_slug/);
});

test("the bridge invokes the existing specialist runtime but publishes through the owner", () => {
  const bridge = read("scripts/conversation_agent_bridge.py");
  assert.match(bridge, /agent_consultation_for_job/);
  assert.match(bridge, /consultation_owner/);
  assert.match(bridge, /do not send messages/);
  assert.match(bridge, /rest\.complete_agent_consultation\(job\["id"\], reply\)/);
  assert.doesNotMatch(bridge, /openclaw_agent_id\("specialist"\)/);
});

test("production verifier proves no implicit participant and no duplicate action", () => {
  const verifier = read("supabase/fixtures/116_conversation_agent_consultations_verify.sql");
  assert.match(verifier, /specialist was silently added to the direct conversation/);
  assert.match(verifier, /retry created duplicate consultation work/);
  assert.match(verifier, /completion retry created a duplicate owner response/);
  assert.match(verifier, /specialist answer was not visibly owned and correctly attributed/);
});
