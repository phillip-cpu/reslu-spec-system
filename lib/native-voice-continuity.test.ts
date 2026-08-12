import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeNativeVoiceContinuity } from "./native-voice-continuity.ts";

test("native continuity metadata is bounded and content-free", () => {
  assert.deepEqual(sanitizeNativeVoiceContinuity({
    schema_version: 1,
    transport: "native_webrtc_callkit",
    background_transitions: 2,
    reconnect_attempts: 1,
    data_channel_opens: 2,
    audio_route_changes: 3,
    callkit_audio_activations: 2,
    mute_changes: 4,
    ended_while_background: true,
    replayed_web_events: 7,
    peak_buffered_web_events: 9,
    transcript: "private words",
    provider_id: "secret-provider-id",
  }), {
    schema_version: 1,
    transport: "native_webrtc_callkit",
    background_transitions: 2,
    reconnect_attempts: 1,
    data_channel_opens: 2,
    audio_route_changes: 3,
    callkit_audio_activations: 2,
    mute_changes: 4,
    ended_while_background: true,
    replayed_web_events: 7,
    peak_buffered_web_events: 9,
  });
});

test("invalid or excessive continuity fields fail closed", () => {
  assert.equal(sanitizeNativeVoiceContinuity([]), null);
  assert.equal(sanitizeNativeVoiceContinuity({ schema_version: 2, transport: "native_webrtc_callkit" }), null);
  assert.deepEqual(sanitizeNativeVoiceContinuity({
    schema_version: 1,
    transport: "native_webrtc_callkit",
    reconnect_attempts: 1_001,
    peak_buffered_web_events: 81,
  })?.reconnect_attempts, 0);
});
