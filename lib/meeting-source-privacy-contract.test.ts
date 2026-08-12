import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

test("meeting source retention is fixed and cannot be extended by browser writes", () => {
  const migration = read("supabase/migrations/115_conversation_meeting_source_retention.sql");
  assert.match(migration, /started_at \+ interval '30 days'/i);
  assert.match(migration, /started_at \+ interval '365 days'/i);
  assert.match(migration, /alter column recording_retain_until set not null/i);
  assert.match(migration, /protected privacy endpoint/i);
  assert.match(migration, /source_exported/);
  assert.match(migration, /source_deleted/);
  assert.match(migration, /retention_purged/);
});

test("source export stays member-scoped and raw-audio access stays recorder-only", () => {
  const source = read("app/api/conversations/[id]/meeting-mode/[meetingId]/source/route.ts");
  assert.match(source, /requireMeetingModeAccess/);
  assert.match(source, /Only the recorder can export the raw meeting audio/);
  assert.match(source, /Only the recorder can delete meeting source material/);
  assert.match(source, /createSignedUrl/);
  assert.match(source, /Cache-Control[\s\S]*private, no-store/);
  assert.match(source, /Content-Disposition/);
  assert.match(source, /transcript_segments: \[\]/);
  assert.match(source, /source_deleted/);
});

test("Meeting Mode discloses retention and requires explicit destructive confirmation", () => {
  const component = read("components/conversations/MeetingMode.tsx");
  assert.match(component, /Source privacy/);
  assert.match(component, /proposed deletion dates/i);
  assert.match(component, /Automatic purging remains off until RESLU approves the policy/);
  assert.match(component, /Permanently delete the \$\{label\}/);
  assert.match(component, /Filed structured minutes will remain/);
  assert.match(component, /Export transcript/);
  assert.match(component, /Export raw audio/);
  assert.match(component, /Delete raw audio/);
  assert.match(component, /Delete transcript/);
});

test("source privacy operations fail closed when their audit event cannot be written", () => {
  const source = read("app/api/conversations/[id]/meeting-mode/[meetingId]/source/route.ts");
  assert.match(source, /if \(error\) throw new Error\(`Meeting source audit failed:/);
});
