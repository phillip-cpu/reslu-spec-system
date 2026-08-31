import assert from "node:assert/strict";
import test from "node:test";
import {
  nativeVoiceBridgeAvailable,
  nativeRealtimeTransportAvailable,
  nativeVoiceBridgeRequiresRealtimeUpgrade,
  prepareNativeRealtimeSession,
  prepareNativeVoiceSession,
} from "./native-voice-bridge.ts";

type TestWindow = EventTarget & {
  __RESLU_NATIVE_VOICE_CAPABILITIES__?: { version?: number; nativeRealtimeTransport?: boolean };
  webkit?: { messageHandlers?: { resluVoice?: { postMessage(value: unknown): void } } };
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
};

function installWindow(value: TestWindow | undefined) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  if (value) Object.defineProperty(globalThis, "window", { configurable: true, value });
  else Reflect.deleteProperty(globalThis, "window");
  return () => {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  };
}

function nativeEvent(type: string, message?: string) {
  const event = new Event("reslu-native-voice") as Event & { detail?: unknown };
  event.detail = { type, message };
  return event;
}

test("Safari and SSR do not wait for a native audio session", async () => {
  const restore = installWindow(undefined);
  try {
    assert.equal(nativeVoiceBridgeAvailable(), false);
    await prepareNativeVoiceSession({
      type: "call.start",
      callId: "call-1",
      clientCallId: "client-call-1",
      conversationId: "conversation-1",
      agent: "Aria",
      agentSlug: "aria",
    }, 1);
  } finally {
    restore();
  }
});

test("the native shell waits for CallKit audio activation", async () => {
  const target = new EventTarget() as TestWindow;
  target.setTimeout = setTimeout;
  target.clearTimeout = clearTimeout;
  let posted: unknown;
  target.webkit = { messageHandlers: { resluVoice: { postMessage(value) {
    posted = value;
    queueMicrotask(() => target.dispatchEvent(nativeEvent("native-audio-ready")));
  } } } };
  const restore = installWindow(target);
  try {
    assert.equal(nativeVoiceBridgeAvailable(), true);
    await prepareNativeVoiceSession({
      type: "call.start",
      callId: "call-1",
      clientCallId: "client-call-1",
      conversationId: "conversation-1",
      agent: "Aria",
      agentSlug: "aria",
    }, 50);
    assert.deepEqual(posted, {
      type: "call.start",
      callId: "call-1",
      clientCallId: "client-call-1",
      conversationId: "conversation-1",
      agent: "Aria",
      agentSlug: "aria",
    });
  } finally {
    restore();
  }
});

test("version two native shell owns the realtime transport", async () => {
  const target = new EventTarget() as TestWindow;
  target.setTimeout = setTimeout;
  target.clearTimeout = clearTimeout;
  target.__RESLU_NATIVE_VOICE_CAPABILITIES__ = { version: 2, nativeRealtimeTransport: true };
  let posted: unknown;
  target.webkit = { messageHandlers: { resluVoice: { postMessage(value) {
    posted = value;
    queueMicrotask(() => target.dispatchEvent(nativeEvent("native-realtime-connected")));
  } } } };
  const restore = installWindow(target);
  const start = {
    type: "call.start" as const,
    callId: "call-1",
    clientCallId: "client-call-1",
    conversationId: "conversation-1",
    agent: "Aria",
    agentSlug: "aria",
  };
  try {
    assert.equal(nativeRealtimeTransportAvailable(), true);
    await prepareNativeRealtimeSession(start, 50);
    assert.deepEqual(posted, { ...start, transport: "native-realtime" });
  } finally {
    restore();
  }
});

test("an older native shell is reported as requiring an upgrade", () => {
  const target = new EventTarget() as TestWindow;
  target.setTimeout = setTimeout;
  target.clearTimeout = clearTimeout;
  target.webkit = { messageHandlers: { resluVoice: { postMessage() {} } } };
  const restore = installWindow(target);
  try {
    assert.equal(nativeVoiceBridgeRequiresRealtimeUpgrade(), true);
  } finally {
    restore();
  }
});

test("native audio activation fails closed on timeout", async () => {
  const target = new EventTarget() as TestWindow;
  target.setTimeout = setTimeout;
  target.clearTimeout = clearTimeout;
  target.webkit = { messageHandlers: { resluVoice: { postMessage() {} } } };
  const restore = installWindow(target);
  try {
    await assert.rejects(
      prepareNativeVoiceSession({
        type: "call.start",
        callId: "call-1",
        clientCallId: "client-call-1",
        conversationId: "conversation-1",
        agent: "Aria",
        agentSlug: "aria",
      }, 1),
      /did not activate in time/
    );
  } finally {
    restore();
  }
});
