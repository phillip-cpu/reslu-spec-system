import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRealtimeSession,
  cancelRealtimeTurn,
  createRealtimeWebRtcCall,
  realtimeConfig,
  realtimeSafetyIdentifier,
  shouldAcceptRealtimeOutput,
} from "./realtime-voice.ts";

test("realtime defaults remain agent-specific and configurable", () => {
  const aria = realtimeConfig({ RESLU_REALTIME_VOICE_ENABLED: "true", OPENAI_API_KEY: "server-key" }, "aria");
  const marco = realtimeConfig({ RESLU_REALTIME_VOICE_ENABLED: "true", OPENAI_API_KEY: "server-key" }, "marco");
  assert.equal(aria.model, "gpt-realtime-2.1");
  assert.equal(aria.transcriptionModel, "gpt-live-transcribe");
  assert.equal(aria.voice, "marin");
  assert.equal(marco.voice, "cedar");
  assert.equal(realtimeConfig({ RESLU_REALTIME_ARIA_VOICE: "coral" }, "aria").voice, "coral");
});

test("session forces substantive turns through the existing RESLU agent", () => {
  const config = realtimeConfig({ RESLU_REALTIME_VOICE_ENABLED: "true", OPENAI_API_KEY: "server-key" }, "aria");
  const session = buildRealtimeSession({ slug: "aria", display_name: "Aria" }, config);
  assert.equal(session.tool_choice, "required");
  assert.equal(session.audio.input.turn_detection.type, "semantic_vad");
  assert.equal(session.audio.input.turn_detection.interrupt_response, true);
  assert.equal(session.audio.input.transcription.model, "gpt-live-transcribe");
  assert.equal(session.audio.input.transcription.delay, "low");
  assert.equal(session.tools[0].name, "consult_reslu_agent");
  assert.equal(session.tools[1].name, "start_reslu_task");
  assert.match(session.tools[1].description, /continues if speech is interrupted/i);
  assert.match(session.instructions, /do not possess RESLU memory/i);
  assert.match(session.instructions, /Never answer a substantive question yourself/i);
});

test("standard API key is sent only to OpenAI by the server provider call", async () => {
  let capturedUrl = "";
  let capturedHeaders: HeadersInit | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedHeaders = init?.headers;
    return new Response("v=0\r\nanswer", { status: 201, headers: { "content-type": "application/sdp" } });
  };
  const config = realtimeConfig({ RESLU_REALTIME_VOICE_ENABLED: "true", OPENAI_API_KEY: "server-key" }, "aria");
  const result = await createRealtimeWebRtcCall({
    sdp: "v=0\r\noffer",
    session: buildRealtimeSession({ slug: "aria", display_name: "Aria" }, config),
    apiKey: "server-key",
    safetyIdentifier: "safe-user",
    fetchImpl,
  });
  const headers = new Headers(capturedHeaders);
  assert.equal(capturedUrl, "https://api.openai.com/v1/realtime/calls");
  assert.equal(headers.get("authorization"), "Bearer server-key");
  assert.equal(headers.get("openai-safety-identifier"), "safe-user");
  assert.equal(result.ok, true);
});

test("provider failures remain structured without leaking the key", async () => {
  const result = await createRealtimeWebRtcCall({
    sdp: "v=0\r\noffer",
    session: buildRealtimeSession(
      { slug: "marco", display_name: "Marco" },
      realtimeConfig({ RESLU_REALTIME_VOICE_ENABLED: "true", OPENAI_API_KEY: "top-secret" }, "marco")
    ),
    apiKey: "top-secret",
    safetyIdentifier: "safe-user",
    fetchImpl: async () => new Response("provider diagnostic", { status: 429 }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 429);
  assert.doesNotMatch(JSON.stringify({ ok: result.ok, status: result.status }), /top-secret/);
});

test("barge-in rejects both late response and late consult output", () => {
  const state = cancelRealtimeTurn({
    responseId: "resp_1",
    toolCallId: "call_1",
    cancelledResponseIds: new Set(),
    cancelledToolCallIds: new Set(),
  });
  assert.equal(shouldAcceptRealtimeOutput(state, "resp_1"), false);
  assert.equal(shouldAcceptRealtimeOutput(state, "resp_2", "call_1"), false);
  assert.equal(shouldAcceptRealtimeOutput(state, "resp_2", "call_2"), true);
});

test("safety identifiers are stable, opaque and do not expose profile ids", () => {
  const first = realtimeSafetyIdentifier("ac1e60f5-3452-4e9e-97c3-90269d38b674");
  const second = realtimeSafetyIdentifier("ac1e60f5-3452-4e9e-97c3-90269d38b674");
  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(first, /ac1e60f5/);
});
