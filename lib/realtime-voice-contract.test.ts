import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const sessionRoute = read("app/api/conversations/[id]/realtime/session/route.ts");
const consultRoute = read("app/api/conversations/[id]/realtime/consult/route.ts");
const workspace = read("components/conversations/ConversationWorkspace.tsx");
const migration = read("supabase/migrations/091_realtime_voice_consults.sql");

test("SDP creation is authenticated, membership-scoped and fails closed", () => {
  assert.match(sessionRoute, /supabase\.auth\.getUser\(\)/);
  assert.match(sessionRoute, /conversationParticipants\(supabase, id, user\.id\)/);
  assert.match(sessionRoute, /authorizedConversationAgent/);
  assert.match(sessionRoute, /OPENAI_API_KEY is not configured on the server/);
  assert.doesNotMatch(sessionRoute, /apiKey:\s*config\.apiKey[\s\S]*NextResponse\.json\([^)]*apiKey/);
});

test("consult turns persist once in the canonical thread and reuse the OpenClaw queue", () => {
  assert.match(consultRoute, /\.from\("conversation_messages"\)[\s\S]*author_profile_id: user\.id/);
  assert.match(consultRoute, /transport: "openai_realtime_webrtc"/);
  assert.match(consultRoute, /\.from\("agent_conversation_jobs"\)/);
  assert.match(consultRoute, /contains\("metadata", \{ job_id: job\.id \}\)/);
  assert.match(migration, /conversation_messages_realtime_tool_call_unique/);
  assert.match(migration, /cancel_realtime_conversation_job/);
});

test("WebRTC call path performs immediate barge-in and suppresses cancelled late output", () => {
  assert.match(workspace, /new RTCPeerConnection\(\)/);
  assert.match(workspace, /input_audio_buffer\.speech_started/);
  assert.match(workspace, /output_audio_buffer\.clear/);
  assert.match(workspace, /cancelledResponseIdsRef/);
  assert.match(workspace, /cancelledToolCallIdsRef/);
  assert.match(workspace, /realtimeActiveRef\.current\) \{/);
});
