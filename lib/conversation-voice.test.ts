import assert from "node:assert/strict";
import test from "node:test";
import {
  isFatalSpeechRecognitionError,
  shouldFallbackToLegacyVoice,
  speechRecognitionErrorMessage,
} from "./conversation-voice.ts";

test("permission and unavailable-service errors stop the reconnect loop", () => {
  assert.equal(isFatalSpeechRecognitionError("not-allowed"), true);
  assert.equal(isFatalSpeechRecognitionError("service-not-allowed"), true);
  assert.equal(isFatalSpeechRecognitionError("no-speech"), false);
  assert.equal(isFatalSpeechRecognitionError("network"), false);
});

test("iPhone speech errors give actionable recovery instructions", () => {
  assert.match(speechRecognitionErrorMessage("not-allowed"), /Website Settings/);
  assert.match(speechRecognitionErrorMessage("service-not-allowed"), /directly in Safari/);
  assert.match(speechRecognitionErrorMessage("service-not-allowed"), /Siri/);
});

test("Safari invalid-constraint failures use the legacy voice recovery path", () => {
  const constrained = new Error("Microphone could not start");
  constrained.name = "OverconstrainedError";
  assert.equal(shouldFallbackToLegacyVoice(constrained), true);
  assert.equal(shouldFallbackToLegacyVoice(new Error("Invalid constraint")), true);
  assert.equal(shouldFallbackToLegacyVoice(new DOMException("Permission denied", "NotAllowedError")), false);
  assert.equal(shouldFallbackToLegacyVoice(new Error("Realtime provider unavailable")), false);
});
