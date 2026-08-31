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

test("realtime session startup failures use the legacy voice recovery path", () => {
  const timedOut = new Error("The connection took too long. RESLU will try again automatically.");
  timedOut.name = "BoundedRequestTimeoutError";
  assert.equal(shouldFallbackToLegacyVoice(timedOut), true);

  const providerError = new Error("The realtime voice provider could not start this call.") as Error & { code?: string };
  providerError.code = "realtime_provider_error";
  assert.equal(shouldFallbackToLegacyVoice(providerError), true);

  const providerUnavailable = new Error("The realtime voice provider is unavailable.") as Error & { code?: string };
  providerUnavailable.code = "realtime_provider_unavailable";
  assert.equal(shouldFallbackToLegacyVoice(providerUnavailable), true);

  assert.equal(shouldFallbackToLegacyVoice(new DOMException("Permission denied", "NotAllowedError")), false);
  assert.equal(shouldFallbackToLegacyVoice(new Error("No conversation selected")), false);
});
