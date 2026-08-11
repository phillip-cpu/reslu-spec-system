import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const migration = read("supabase/migrations/109_conversation_voice_notes.sql");
const verifier = read("supabase/fixtures/109_conversation_voice_notes_verify.sql");
const attachmentRoute = read("app/api/conversations/[id]/attachments/route.ts");
const uploadUrlRoute = read("app/api/conversations/[id]/attachments/upload-url/route.ts");
const messageRoute = read("app/api/conversations/[id]/messages/route.ts");
const workspace = read("components/conversations/ConversationWorkspace.tsx");
const bridge = read("scripts/conversation_agent_bridge.py");
const fileSniff = read("lib/file-sniff.ts");

test("voice-note bytes remain private canonical attachments with bounded metadata", () => {
  assert.match(migration, /'audio\/mp4', 'audio\/webm'/);
  assert.match(migration, /duration_ms not between 250 and 300000/i);
  assert.match(migration, /conversation_attachments_voice_note_metadata_check/i);
  assert.match(migration, /conversation_forwarded_attachments_voice_note_metadata_check/i);
  assert.match(migration, /revoke all on function valid_conversation_voice_note_metadata/i);
  assert.match(verifier, /RESLU_VERIFY_109_PASS/);
  assert.match(verifier, /all test changes rolled back/i);
});

test("server verifies MP4 or WebM bytes and requires truthful recording metadata", () => {
  assert.match(fileSniff, /return "mp4"/);
  assert.match(fileSniff, /return "webm"/);
  assert.match(attachmentRoute, /isConversationVoiceNoteDuration/);
  assert.match(attachmentRoute, /voice_note/);
  assert.match(attachmentRoute, /Voice notes must be no larger than 10 MB/);
  assert.match(uploadUrlRoute, /voiceNoteMetadata/);
  assert.match(uploadUrlRoute, /duration_ms/);
});

test("iPhone and desktop expose a cancellable five-minute recording flow", () => {
  assert.match(workspace, /function VoiceNoteRecorder/);
  assert.match(workspace, /navigator\.mediaDevices\.getUserMedia/);
  assert.match(workspace, /MediaRecorder\.isTypeSupported/);
  assert.match(workspace, /MAX_CONVERSATION_VOICE_NOTE_DURATION_MS/);
  assert.match(workspace, /Cancel/);
  assert.match(workspace, /Finish/);
  assert.match(workspace, /voiceNoteDurationMs/);
  assert.match(workspace, /aria-label="Record voice note"/);
});

test("voice notes use the exact-once outbox and render an authenticated audio player", () => {
  assert.match(messageRoute, /body\.source !== "voice_note"/);
  assert.match(messageRoute, /source: body\.source === "voice"[\s\S]*"voice_note"/);
  assert.match(workspace, /source: voiceNote \? "voice_note" : "text"/);
  assert.match(workspace, /<audio controls playsInline preload="metadata"/);
  assert.match(workspace, /attachment\.url/);
  assert.match(attachmentRoute, /request\.headers\.get\("range"\)/);
  assert.match(attachmentRoute, /Content-Range/);
});

test("forwarding and the existing Aria\/Marco bridge preserve voice-note context", () => {
  assert.match(migration, /alter table conversation_forwarded_attachments/);
  assert.match(bridge, /metadata\.get\("voice_note"\) is True/);
  assert.match(bridge, /Private voice note/);
  assert.match(bridge, /Voice note \(/);
});

test("no new automatic transcription destination is introduced", () => {
  assert.doesNotMatch(attachmentRoute, /api\.openai\.com|audio\/transcriptions|OPENAI_API_KEY/);
  assert.doesNotMatch(uploadUrlRoute, /api\.openai\.com|audio\/transcriptions|OPENAI_API_KEY/);
});
