import assert from "node:assert/strict";
import test from "node:test";
import {
  nativeVoiceBridgeAvailable,
  prepareNativeVoiceSession,
} from "./native-voice-bridge.ts";

type TestWindow = EventTarget & {
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
      conversationId: "conversation-1",
      agent: "Aria",
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
      conversationId: "conversation-1",
      agent: "Aria",
    }, 50);
    assert.deepEqual(posted, {
      type: "call.start",
      callId: "call-1",
      conversationId: "conversation-1",
      agent: "Aria",
    });
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
        conversationId: "conversation-1",
        agent: "Aria",
      }, 1),
      /did not activate in time/
    );
  } finally {
    restore();
  }
});
