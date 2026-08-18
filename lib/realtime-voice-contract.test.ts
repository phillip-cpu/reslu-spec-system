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
  assert.match(consultRoute, /async function ensureAgentJob/);
  assert.match(consultRoute, /if \(!result\.job\)/);
  assert.match(consultRoute, /consultMessageMatchesIntent\(existing\.data, body\)/);
  assert.match(consultRoute, /already used for a different voice turn/);
  assert.match(consultRoute, /existing\.data[\s\S]*ensureAgentJob/);
});

test("realtime consult creation fails closed if supersession or enqueue is not proven", () => {
  assert.match(consultRoute, /const \{ error: cancellationError \} = await supabase\.rpc\("cancel_agent_conversation_jobs"/);
  assert.match(consultRoute, /previous voice turn could not be interrupted safely/);
  assert.match(consultRoute, /Your voice turn was saved, but the selected RESLU agent could not be reached yet/);
  assert.match(consultRoute, /status: 503/);
});

test("WebRTC call path performs immediate barge-in and suppresses cancelled late output", () => {
  assert.match(workspace, /new RTCPeerConnection\(\)/);
  assert.match(workspace, /input_audio_buffer\.speech_started/);
  assert.match(workspace, /output_audio_buffer\.clear/);
  assert.match(workspace, /cancelledResponseIdsRef/);
  assert.match(workspace, /cancelledToolCallIdsRef/);
  assert.match(workspace, /realtimeActiveRef\.current\) \{/);
});

test("VAD speech start interrupts audio without cancelling an unfinished agent consult", () => {
  const speechStarted = workspace.match(
    /if \(event\.type === "input_audio_buffer\.speech_started"\) \{([\s\S]*?)\n    \}/
  )?.[1] ?? "";
  assert.match(speechStarted, /interruptRealtimePlayback\(performance\.now\(\)(?:,[^)]*)?\)/);
  assert.doesNotMatch(speechStarted, /cancelActiveRealtime(?:Turn|Consult)\(\)/);
  assert.match(workspace, /if \(activeRealtimeConsultRef\.current\) cancelActiveRealtimeConsult\(\)/);
});

test("foreground recovery reuses the canonical call without replaying its start intent", () => {
  const recovery = workspace.match(
    /const recoverRealtimeCall = useCallback\(async \(\) => \{([\s\S]*?)\n  \}, \[scheduleRealtimeReconnect, startRealtimeCall\]\);/
  )?.[1] ?? "";
  assert.match(recovery, /const activeCallId = callIdRef\.current/);
  assert.match(recovery, /await startRealtimeCall\(stream, activeCallId\)/);
  assert.doesNotMatch(recovery, /createCallRecord/);
  assert.doesNotMatch(recovery, /cancelActiveRealtimeConsult|cancelActiveRealtimeTurn/);
  assert.match(workspace, /realtimeConnectionGenerationRef/);
  assert.match(workspace, /MAX_REALTIME_RECONNECT_ATTEMPTS/);
  assert.match(workspace, /document\.addEventListener\("visibilitychange", resumeRealtimeCall\)/);
  assert.match(workspace, /window\.addEventListener\("online", resumeRealtimeCall\)/);
  assert.match(workspace, />\s*Reconnect\s*<\/button>/);
});

test("partial provider tool arguments wait for response.done fallback", () => {
  assert.match(workspace, /parseRealtimeConsultArguments\(argumentsJson\)/);
  assert.match(workspace, /parseRealtimeSpecialistArguments\(argumentsJson, callAgent\.agent_slug\)/);
  assert.match(workspace, /parseRealtimeTaskArguments\(argumentsJson\)/);
  assert.match(workspace, /if \(!parsedArguments && deferInvalidArguments\) return/);
  assert.match(workspace, /response\.function_call_arguments\.done[\s\S]*runRealtimeConsult\([^\n]+, true\)/);
  assert.match(workspace, /response\.function_call_arguments\.done[\s\S]*runRealtimeTask\([^\n]+, true\)/);
});
