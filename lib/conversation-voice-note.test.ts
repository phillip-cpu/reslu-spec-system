import assert from "node:assert/strict";
import test from "node:test";
import {
  isConversationVoiceNoteDuration,
  isConversationVoiceNoteMime,
  isVoiceNoteMetadata,
  MAX_CONVERSATION_VOICE_NOTE_BYTES,
  voiceNoteDurationLabel,
  voiceNoteExtension,
  voiceNoteMetadata,
} from "./conversation-voice-note.ts";

test("voice notes use only the two browser recording containers", () => {
  assert.equal(isConversationVoiceNoteMime("audio/mp4"), true);
  assert.equal(isConversationVoiceNoteMime("audio/webm"), true);
  assert.equal(isConversationVoiceNoteMime("audio/mpeg"), false);
  assert.equal(voiceNoteExtension("audio/mp4"), "m4a");
  assert.equal(voiceNoteExtension("audio/webm"), "webm");
  assert.equal(MAX_CONVERSATION_VOICE_NOTE_BYTES, 10 * 1024 * 1024);
});

test("voice-note duration and metadata stay inside the five-minute boundary", () => {
  assert.equal(isConversationVoiceNoteDuration(249), false);
  assert.equal(isConversationVoiceNoteDuration(250), true);
  assert.equal(isConversationVoiceNoteDuration(300_000), true);
  assert.equal(isConversationVoiceNoteDuration(300_001), false);
  assert.deepEqual(voiceNoteMetadata(12_000), { voice_note: true, duration_ms: 12_000 });
  assert.equal(isVoiceNoteMetadata(voiceNoteMetadata(12_000)), true);
  assert.equal(isVoiceNoteMetadata({ voice_note: true, duration_ms: 0 }), false);
  assert.equal(voiceNoteDurationLabel(12_400), "0:12");
  assert.equal(voiceNoteDurationLabel(65_000), "1:05");
});
