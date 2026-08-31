import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanMeetingSourceRetentionUpdate,
  MEETING_RETENTION_ENABLE_CONFIRMATION,
} from "./meeting-retention.ts";

test("retention periods stay bounded and transcripts cannot expire before recordings", () => {
  assert.deepEqual(cleanMeetingSourceRetentionUpdate({
    recording_days: 30,
    transcript_days: 365,
    action: "save",
  }), { recordingDays: 30, transcriptDays: 365, action: "save" });
  assert.equal(cleanMeetingSourceRetentionUpdate({ recording_days: 0, transcript_days: 365, action: "save" }), null);
  assert.equal(cleanMeetingSourceRetentionUpdate({ recording_days: 30, transcript_days: 29, action: "save" }), null);
  assert.equal(cleanMeetingSourceRetentionUpdate({ recording_days: 30.5, transcript_days: 365, action: "save" }), null);
});

test("automatic deletion needs the exact irreversible-action confirmation", () => {
  assert.equal(cleanMeetingSourceRetentionUpdate({
    recording_days: 30,
    transcript_days: 365,
    action: "enable",
  }), null);
  assert.deepEqual(cleanMeetingSourceRetentionUpdate({
    recording_days: 30,
    transcript_days: 365,
    action: "enable",
    confirmation: MEETING_RETENTION_ENABLE_CONFIRMATION,
  }), { recordingDays: 30, transcriptDays: 365, action: "enable" });
});
