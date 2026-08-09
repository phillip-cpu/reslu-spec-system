import assert from "node:assert/strict";
import test from "node:test";
import {
  isFatalSpeechRecognitionError,
  speechRecognitionErrorMessage,
} from "./conversation-voice";

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
