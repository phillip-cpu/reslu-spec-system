import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_REALTIME_RECONNECT_ATTEMPTS,
  mediaStreamCanResume,
  realtimeReconnectDelay,
  shouldAttemptRealtimeReconnect,
} from "./realtime-call-recovery.ts";

const disconnected = {
  callActive: true,
  realtimeActive: true,
  online: true,
  visible: true,
  backgroundCapable: false,
  inFlight: false,
  attempts: 0,
  microphoneReady: true,
  connectionState: "disconnected" as const,
  dataChannelState: "closed" as const,
};

test("realtime recovery requires a visible online active call", () => {
  assert.equal(shouldAttemptRealtimeReconnect(disconnected), true);
  assert.equal(shouldAttemptRealtimeReconnect({ ...disconnected, online: false }), false);
  assert.equal(shouldAttemptRealtimeReconnect({ ...disconnected, visible: false }), false);
  assert.equal(shouldAttemptRealtimeReconnect({ ...disconnected, visible: false, backgroundCapable: true }), true);
  assert.equal(shouldAttemptRealtimeReconnect({ ...disconnected, callActive: false }), false);
  assert.equal(shouldAttemptRealtimeReconnect({ ...disconnected, inFlight: true }), false);
});

test("a healthy peer and data channel never create a duplicate session", () => {
  assert.equal(shouldAttemptRealtimeReconnect({
    ...disconnected,
    connectionState: "connected",
    dataChannelState: "open",
  }), false);
  assert.equal(shouldAttemptRealtimeReconnect({
    ...disconnected,
    connectionState: "connecting",
    dataChannelState: "connecting",
  }), false);
  assert.equal(shouldAttemptRealtimeReconnect({
    ...disconnected,
    attempts: MAX_REALTIME_RECONNECT_ATTEMPTS,
  }), false);
  assert.equal(shouldAttemptRealtimeReconnect({
    ...disconnected,
    connectionState: "connected",
    dataChannelState: "open",
    microphoneReady: false,
  }), true);
});

test("realtime reconnect retries are bounded and back off", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 10].map((attempt) => realtimeReconnectDelay(attempt)), [400, 800, 1600, 3000, 5000, 5000]);
  assert.equal(realtimeReconnectDelay(4, true), 0);
});

test("a resumable microphone stream needs one live audio track", () => {
  const stream = {
    active: true,
    getAudioTracks: () => [{ readyState: "ended" }, { readyState: "live" }],
  } as unknown as MediaStream;
  assert.equal(mediaStreamCanResume(stream), true);
  assert.equal(mediaStreamCanResume({ ...stream, active: false } as MediaStream), false);
  assert.equal(mediaStreamCanResume(null), false);
});
