import assert from "node:assert/strict";
import test from "node:test";
import { cleanStringList, validLeadMeetingStoragePath } from "./lead-meeting-utils.ts";

test("lead meeting storage paths cannot be reassigned to another lead or user", () => {
  const path = "lead-meetings/lead-a/user-a/123-meeting.m4a";
  assert.equal(validLeadMeetingStoragePath(path, "lead-a", "user-a"), true);
  assert.equal(validLeadMeetingStoragePath(path, "lead-b", "user-a"), false);
  assert.equal(validLeadMeetingStoragePath(path, "lead-a", "user-b"), false);
  assert.equal(validLeadMeetingStoragePath("lead-meetings/lead-a/user-a/../secret", "lead-a", "user-a"), false);
});

test("transcription action lists are trimmed and bounded", () => {
  assert.deepEqual(cleanStringList([" Call supplier ", "", 4, "Send drawing"]), ["Call supplier", "Send drawing"]);
});
