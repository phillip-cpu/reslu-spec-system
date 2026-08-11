import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  cleanMeetingStringList,
  cleanMeetingTranscriptSegments,
  meetingRecordingStoragePath,
  rankMeetingCandidates,
  transcriptFromMeetingSegments,
  validMeetingRecordingStoragePath,
} from "./meeting-mode.ts";
import type { MeetingDestinationCandidate } from "../types/meeting-mode.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

test("meeting context auto-selects only one clearly dominant candidate", () => {
  const candidates: MeetingDestinationCandidate[] = [
    { kind: "project", id: "p1", label: "Smith", subtitle: null, client_event_id: "e1", source_reference: "client_event:e1", duplicate_filed_minutes_id: null, confidence: 0.96, reasons: ["now"], meeting_type: "design_meeting" },
    { kind: "lead", id: "l1", label: "Jones", subtitle: null, client_event_id: null, source_reference: null, duplicate_filed_minutes_id: null, confidence: 0.52, reasons: ["active"], meeting_type: "new_lead" },
  ];
  assert.equal(rankMeetingCandidates(candidates).suggested?.id, "p1");
  assert.equal(rankMeetingCandidates([{ ...candidates[0], confidence: 0.88 }, { ...candidates[1], confidence: 0.8 }]).suggested, null);
});

test("two nearby calendar events for one project remain ambiguous", () => {
  const sameProjectEvents: MeetingDestinationCandidate[] = [
    { kind: "project", id: "p1", label: "Smith", subtitle: "Design · 10:00 am", client_event_id: "e1", source_reference: "client_event:e1", duplicate_filed_minutes_id: null, confidence: 0.98, reasons: ["now"], meeting_type: "design_meeting" },
    { kind: "project", id: "p1", label: "Smith", subtitle: "Site · 11:00 am", client_event_id: "e2", source_reference: "client_event:e2", duplicate_filed_minutes_id: null, confidence: 0.93, reasons: ["nearby"], meeting_type: "site_meeting" },
  ];
  const ranked = rankMeetingCandidates(sameProjectEvents);
  assert.equal(ranked.candidates.length, 2);
  assert.equal(ranked.suggested, null);
  assert.equal(ranked.needsClarification, true);
});

test("meeting transcript input is ordered, deduplicated and bounded", () => {
  const segments = cleanMeetingTranscriptSegments([
    { item_id: "b", text: " Second ", sequence: 2, captured_at: "2026-08-11T00:00:02Z" },
    { item_id: "a", text: " First ", sequence: 1, captured_at: "2026-08-11T00:00:01Z" },
    { item_id: "a", text: "duplicate", sequence: 3, captured_at: "2026-08-11T00:00:03Z" },
    { item_id: "bad", text: 5, sequence: 4 },
  ]);
  assert.deepEqual(segments.map((segment) => segment.item_id), ["a", "b"]);
  assert.equal(transcriptFromMeetingSegments(segments), "First\nSecond");
  assert.deepEqual(cleanMeetingStringList([" Action ", "", 4]), ["Action"]);
});

test("private recording paths cannot be reassigned across meetings", () => {
  const path = meetingRecordingStoragePath("conversation-a", "user-a", "meeting-a", "Client Voice.M4A");
  assert.equal(validMeetingRecordingStoragePath(path, "conversation-a", "user-a", "meeting-a"), true);
  assert.equal(validMeetingRecordingStoragePath(path, "conversation-b", "user-a", "meeting-a"), false);
  assert.equal(validMeetingRecordingStoragePath(path, "conversation-a", "user-b", "meeting-a"), false);
  assert.equal(validMeetingRecordingStoragePath(path, "conversation-a", "user-a", "meeting-b"), false);
});

test("Meeting Mode stays local-Whisper, staged and explicitly filed", () => {
  const migration = read("supabase/migrations/103_conversation_meeting_mode.sql");
  const component = read("components/conversations/MeetingMode.tsx");
  const lifecycle = read("app/api/conversations/[id]/meeting-mode/[meetingId]/route.ts");
  const draft = read("app/api/meeting-minutes/[id]/draft/route.ts");
  const realtime = read("lib/realtime-voice.ts");
  assert.match(migration, /status in \('recording','paused','processing','review','filed','discarded','failed'\)/i);
  assert.match(migration, /file_conversation_meeting_minutes/i);
  assert.match(migration, /choose a lead or project before filing/i);
  assert.match(migration, /meeting minutes changed; refresh before filing/i);
  assert.match(migration, /alter table conversation_meeting_minutes enable row level security/i);
  assert.match(migration, /meeting minutes can only be filed through explicit approval/i);
  assert.match(migration, /meeting capture identity and source are immutable/i);
  assert.match(migration, /old\.created_by <> auth\.uid\(\)[\s\S]*only the recorder can control or discard this meeting capture/i);
  assert.match(migration, /old\.status in \('recording','paused','processing','failed'\)/i);
  assert.match(component, /It is not sent to OpenAI/);
  assert.match(component, /savePendingConversationMeetingAudio/);
  assert.match(component, /Approve & file/);
  assert.match(component, /Unassigned draft/);
  assert.match(component, /candidate\.client_event_id \? `\$\{destination\}:event:\$\{candidate\.client_event_id\}`/);
  assert.match(component, /candidates\.find\(\(candidate\) => destinationValue\(candidate\) === selectedDestination\)/);
  assert.match(lifecycle, /transcribe it with local Whisper only/i);
  assert.match(lifecycle, /Only the recorder can control this meeting capture/);
  assert.match(lifecycle, /\.eq\("status", "failed"\)[\s\S]*Meeting processing already resumed/);
  assert.match(draft, /Only Aria can prepare this draft/);
  assert.match(draft, /Meeting is no longer processing; late draft ignored/);
  assert.match(draft, /\.eq\("status", "processing"\)[\s\S]*\.eq\("draft_version"/);
  assert.match(realtime, /name: "start_meeting_mode"/);
  const start = read("app/api/conversations/[id]/meeting-mode/route.ts");
  const context = read("lib/meeting-mode-server.ts");
  assert.match(start, /from\("conversation_calls"\)[\s\S]*\.eq\("conversation_id", id\)/);
  assert.doesNotMatch(start, /api\.openai\.com/);
  assert.match(context, /project:\$\{project\.id\}:event:\$\{event\.id\}/);
  assert.match(context, /projectIdsWithCalendarEvents/);
  assert.match(context, /missingEventProjectIds/);
  assert.match(context, /A concrete calendar association is stronger evidence than recency\/status/);
  assert.match(start, /candidate\.client_event_id === requestedClientEventId/);
  assert.match(start, /source_reference: selected\.source_reference/);
  assert.match(context, /lead_visit:\$\{lead\.id\}:\$\{lead\.site_visit_date\}/);
  assert.doesNotMatch(context, /\.not\("client_event_id", "is", null\)/);
  assert.match(migration, /minutes are already filed for this lead visit/i);
});
